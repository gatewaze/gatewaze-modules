/**
 * Broadcast binding for the Central Sending Service engine (Phase 2 — the second
 * consumer after newsletters). Maps the generic worker drip engine onto
 * broadcast_sends, mirroring the Edge broadcast-send fn so the two render
 * identically.
 *
 * Fidelity: rather than per-recipient string replacement (what the Edge does),
 * the binding resolves whatever tokens the stored rendered_html contains into
 * SendGrid `substitutions` keyed by the exact token string — merge fields (incl.
 * `{{field|"fallback"}}`) + the topic-based unsubscribe URLs. The unsubscribe
 * footer the Edge injects per-recipient when no {{unsubscribe_url}} placeholder
 * exists is injected ONCE here (in buildSendContext) so the single batch body
 * carries the tokens.
 *
 * Per-recipient send-time blocks (weather, local events, virtual events) resolve
 * exactly as newsletters do — via the SAME shared resolvers — so a recipient
 * gets their own rendered block or it's omitted entirely (empty substitution).
 * Per-occurrence block-level link tracking on the worker path is still
 * newsletter-only (not yet ported here).
 */
import { createHmac } from 'node:crypto';
import type { EngineDeps, SendContext, SendEngineBinding, Recipient } from '../../bulk-emailing/worker/send-engine/engine.js';
// Shared per-recipient send-time block resolution (per spec-broadcasts-blocks §11.4).
import {
  LOCAL_TOKEN, VIRTUAL_TOKEN, parseLocalConfig, parseVirtualConfig, stripEventMarkers,
  pickLoc, areaKey, renderEventsHtml, resolveLocalEvents, resolveVirtualEvents,
  type LocalConfig, type EventRpcClient,
} from '../../newsletters/workers/event-personalisation.js';
import { WEATHER_TOKENS, resolveWeather } from '../../newsletters/workers/weather-personalisation.js';

const MERGE_FIELDS = ['first_name', 'last_name', 'name', 'company', 'job_title'];
const MERGE_GROUP = MERGE_FIELDS.join('|');

type BcCtx = SendContext & {
  listId: string | null;            // category list this broadcast is sent as part of (unsubscribe target)
  hmacSecret?: string;
  portalBaseUrl: string | null;
  supabaseUrl: string;
  tokens: string[];                            // exact {{...}} strings in html+subject
  usesMergeFields: boolean;
  attrs: Map<string, Record<string, unknown>>; // email -> attributes
  // Per-recipient send-time blocks (shared with newsletters).
  usesWeather: boolean; weatherUnits: 'celsius' | 'fahrenheit';
  weatherCache: Map<string, Record<string, string>>; // city|country|units -> {weather_* -> value}
  usesLocalEvents: boolean; localConfig: LocalConfig;
  localEventsCache: Map<string, string>;             // area key -> rendered events HTML (or '')
  virtualEventsHtml: string;                         // resolved once per send (global); '' when none/unused
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function unquote(fb: string): string {
  const t = fb.trim();
  return (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) ? t.slice(1, -1) : t;
}
function scanTokens(html: string, subject: string): string[] {
  const set = new Set<string>();
  const re = /\{\{[^}]+\}\}/g;
  for (const s of [html, subject]) { let m; while ((m = re.exec(s))) set.add(m[0]); }
  return [...set];
}
function htmlUsesMergeFields(s: string): boolean {
  return new RegExp(`\\{\\{\\s*(?:${MERGE_GROUP})\\b`).test(s);
}
// List-based unsubscribe token — same shape as newsletters (email:list_id:
// timestamp), so broadcasts reuse the shared generic list-unsubscribe
// (newsletter-unsubscribe edge fn + portal Subscription Centre). base64url
// payload + HMAC-SHA256 base64url signature.
function genUnsubToken(email: string, listId: string, secret: string): string {
  const payload = `${email}:${listId}:${Date.now()}`;
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

export const broadcastBinding: SendEngineBinding = {
  domain: 'broadcast',
  sendsTable: 'broadcast_sends',
  recipientsTable: 'broadcast_send_recipients',
  batchesTable: 'broadcast_send_batches',
  logSendIdColumn: 'broadcast_send_id',
  claimRpc: 'claim_due_broadcast_recipients',

  async buildSendContext(deps: EngineDeps, sendId: string): Promise<SendContext | null> {
    const { data: send } = await deps.supabase.from('broadcast_sends').select('*').eq('id', sendId).single();
    if (!send || !send.rendered_html) return null;

    const subject: string = send.subject || 'Message';
    let html: string = send.rendered_html;

    // The Edge injects an unsubscribe footer per-recipient when the body has no
    // {{unsubscribe_url}} placeholder. Do it once here so the batch body carries
    // the tokens (SendGrid substitutes per recipient).
    if (!/\{\{unsubscribe_url\}\}/.test(html)) {
      const footer =
        `<div style="text-align:center;padding:20px;font-size:12px;color:#999;">` +
        `<a href="{{unsubscribe_url}}" style="color:#999;">Unsubscribe</a> &middot; ` +
        `<a href="{{manage_subscriptions_url}}" style="color:#999;">Manage your email preferences</a></div>`;
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${footer}</body>`) : html + footer;
    }

    const metadata = (send.metadata ?? {}) as { portal_base_url?: string };
    const portalBaseUrl: string | null = metadata.portal_base_url || process.env.SITE_URL || null;

    // Per-recipient send-time blocks: detect the tokens, parse per-block config
    // from the marker comments, then strip the markers so they don't ship.
    // Weather + local events resolve per recipient later; virtual events are
    // global (same for everyone) so resolve them once here.
    const usesWeather = /\{\{weather_(emoji|temp|summary|location)\}\}/.test(html);
    const unitMarker = html.match(/<!--gw-weather-units:(celsius|fahrenheit)-->/);
    const usesLocalEvents = html.includes(LOCAL_TOKEN);
    const usesVirtualEvents = html.includes(VIRTUAL_TOKEN);
    const localConfig = parseLocalConfig(html);
    const virtualConfig = parseVirtualConfig(html);
    html = stripEventMarkers(html);

    let virtualEventsHtml = '';
    if (usesVirtualEvents) {
      try {
        const events = await resolveVirtualEvents(deps.supabase as unknown as EventRpcClient, virtualConfig, new Date().toISOString());
        virtualEventsHtml = renderEventsHtml(events, { heading: virtualConfig.heading, intro: virtualConfig.intro, portalBaseUrl });
      } catch (e) { deps.logger.warn('[send-engine] broadcast virtual events resolve failed', e); }
    }

    const ctx: BcCtx = {
      sendId,
      brand: send.brand || process.env.SEND_ENGINE_DEFAULT_BRAND || 'default',
      channel: send.channel || 'email',
      subject, html,
      fromEmail: send.from_address || process.env.BULK_EMAIL_FROM_ADDRESS || process.env.EMAIL_FROM || 'noreply@localhost',
      fromName: send.from_name || process.env.BULK_EMAIL_FROM_NAME || process.env.EMAIL_FROM_NAME || 'Gatewaze',
      replyTo: send.reply_to || null,
      disableSubscriptionTracking: true,
      // The category list this broadcast is sent as part of = the unsubscribe
      // target. Falls back to the audience list when the audience IS a list.
      listId: send.category_list_id || (send.list_ids || [])[0] || null,
      hmacSecret: process.env.UNSUBSCRIBE_HMAC_SECRET,
      portalBaseUrl,
      supabaseUrl: process.env.SUPABASE_URL || '',
      // scan AFTER stripping markers (markers gone; {{tokens}} remain).
      tokens: scanTokens(html, subject),
      usesMergeFields: htmlUsesMergeFields(html) || htmlUsesMergeFields(subject),
      attrs: new Map(),
      usesWeather, weatherUnits: unitMarker && unitMarker[1] === 'fahrenheit' ? 'fahrenheit' : 'celsius',
      weatherCache: new Map(),
      usesLocalEvents, localConfig, localEventsCache: new Map(), virtualEventsHtml,
    };
    return ctx;
  },

  async prepareBatch(deps: EngineDeps, ctx: SendContext, recipients: Recipient[]): Promise<void> {
    const c = ctx as BcCtx;
    // Recipient attributes are needed for merge fields AND for per-recipient
    // weather / local-events location lookup.
    if (!c.usesMergeFields && !c.usesWeather && !c.usesLocalEvents) return;
    const emails = recipients.map((r) => r.email).filter(Boolean) as string[];
    for (let i = 0; i < emails.length; i += 500) {
      const { data } = await deps.supabase.from('people').select('email, attributes').in('email', emails.slice(i, i + 500));
      for (const row of data ?? []) c.attrs.set(row.email, row.attributes ?? {});
    }

    // Local events: resolve once per unique area (recipients in the same metro
    // share a lookup + rendered HTML). Cache persists across batches on the ctx.
    if (c.usesLocalEvents) {
      const afterIso = new Date().toISOString();
      for (const r of recipients) {
        const attrs = (r.email && c.attrs.get(r.email)) || {};
        const key = areaKey(pickLoc(attrs));
        if (!key || c.localEventsCache.has(key)) continue;
        try {
          const loc = pickLoc(attrs);
          const events = await resolveLocalEvents(deps.supabase as unknown as EventRpcClient, loc, c.localConfig, afterIso);
          c.localEventsCache.set(key, renderEventsHtml(events, { heading: c.localConfig.heading, intro: c.localConfig.intro, portalBaseUrl: c.portalBaseUrl }));
        } catch (e) {
          c.localEventsCache.set(key, ''); // resolve failed → omit the block for this area
          deps.logger.warn('[send-engine] broadcast local events resolve failed', e);
        }
      }
    }
  },

  async buildSubstitutions(ctx: SendContext, r: Recipient, headers: Record<string, string>): Promise<Record<string, string>> {
    const c = ctx as BcCtx;
    const attrs = (r.email && c.attrs.get(r.email)) || {};
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
    const nameVal = () => [str(attrs.first_name), str(attrs.last_name)].filter(Boolean).join(' ');

    // Per-recipient weather (cached by city|country|units).
    let weather: Record<string, string> | null = null;
    if (c.usesWeather) {
      const city = str(attrs.city), country = str(attrs.country);
      const key = `${city.toLowerCase()}|${country.toLowerCase()}|${c.weatherUnits}`;
      weather = c.weatherCache.get(key) ?? null;
      if (!weather) { weather = await resolveWeather(city, country, c.weatherUnits); c.weatherCache.set(key, weather); }
    }

    // List-based unsubscribe URLs + List-Unsubscribe header — shared with
    // newsletters (generic list-unsubscribe + Subscription Centre).
    let unsubUrl = '', manageUrl = '';
    if (c.hmacSecret && r.email && c.listId) {
      const tok = encodeURIComponent(genUnsubToken(r.email, c.listId, c.hmacSecret));
      const oneClick = `${c.supabaseUrl}/functions/v1/newsletter-unsubscribe?token=${tok}`;
      const base = c.portalBaseUrl ? c.portalBaseUrl.replace(/\/$/, '') : null;
      unsubUrl = base ? `${base}/subscriptions?token=${tok}&unsub=1` : oneClick;
      manageUrl = base ? `${base}/subscriptions?token=${tok}` : oneClick;
      headers['List-Unsubscribe'] = `<${oneClick}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }

    const subs: Record<string, string> = {};
    for (const token of c.tokens) {
      const inner = token.slice(2, -2).trim();              // strip {{ }}
      if (inner === 'unsubscribe_url') { subs[token] = unsubUrl; continue; }
      if (inner === 'manage_subscriptions_url') { subs[token] = manageUrl; continue; }
      if (weather && WEATHER_TOKENS.includes(inner)) { subs[token] = weather[inner] ?? ''; continue; }
      // Event blocks: substitute the self-contained rendered HTML (raw, not
      // escaped) or '' — '' omits the block entirely for this recipient. Always
      // set so SendGrid never leaves the literal {{token}} in a recipient's email.
      if (inner === 'local_events_block') {
        const key = c.usesLocalEvents ? areaKey(pickLoc(attrs)) : null;
        subs[token] = (key && c.localEventsCache.get(key)) || '';
        continue;
      }
      if (inner === 'virtual_events_block') { subs[token] = c.virtualEventsHtml || ''; continue; }
      const m = inner.match(/^([a-z_]+)\s*(?:\|(.*))?$/);
      if (m && MERGE_FIELDS.includes(m[1])) {
        let val = m[1] === 'name' ? nameVal() : str(attrs[m[1]]);
        if (!val && m[2] !== undefined) val = unquote(m[2]);
        subs[token] = escapeHtml(val);
      }
    }
    return subs;
  },
};
