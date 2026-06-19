/**
 * Newsletter binding for the Central Sending Service engine (the first consumer
 * / Tier 2 canary). Maps the generic engine onto newsletter_sends.
 *
 * Fidelity: rather than change the production render, the binding resolves
 * whatever tokens the stored rendered_html already contains into SendGrid
 * `substitutions` keyed by the EXACT token string. This covers merge fields
 * (incl. `{{field|"fallback"}}`), weather (`{{weather_*}}`, geocoded per
 * recipient, cached), and unsubscribe URLs — one SendGrid substitution pass, no
 * double-substitution.
 *
 * Remaining gap (analytics, not delivery): per-occurrence block-level link
 * tracking (syncEditionLinkRegistry/tagHtmlLinks) is NOT yet applied on the
 * worker path — editions relying on block click-attribution should stay on the
 * Edge drip until ported. Plain links + opens still track via SendGrid.
 */
import { createHmac } from 'node:crypto';
import type { EngineDeps, SendContext, SendEngineBinding, Recipient } from '../../bulk-emailing/worker/send-engine/engine.js';

const MERGE_FIELDS = ['first_name', 'last_name', 'name', 'company', 'job_title'];
const WEATHER_TOKENS = ['weather_emoji', 'weather_temp', 'weather_summary', 'weather_location'];

type NlCtx = SendContext & {
  listId: string; hmacSecret?: string; portalBaseUrl: string | null;
  tokens: string[];                                  // exact {{...}} strings present in html+subject
  usesWeather: boolean; weatherUnits: 'celsius' | 'fahrenheit';
  attrs: Map<string, Record<string, unknown>>;       // email -> attributes
  weatherCache: Map<string, Record<string, string>>; // city|country|units -> {weather_* -> value}
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function genUnsubToken(email: string, listId: string, secret: string): string {
  const payload = `${email}:${listId}:${Date.now()}`;
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
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

// --- weather (open-meteo), ported to Node ----------------------------------
function weatherEmoji(code: number): { emoji: string; summary: string } {
  if (code === 0) return { emoji: '☀️', summary: 'Clear sky' };
  if (code <= 2) return { emoji: '⛅', summary: 'Partly cloudy' };
  if (code === 3) return { emoji: '☁️', summary: 'Overcast' };
  if (code >= 45 && code <= 48) return { emoji: '🌫️', summary: 'Fog' };
  if (code >= 51 && code <= 67) return { emoji: '🌧️', summary: 'Rain' };
  if (code >= 71 && code <= 86) return { emoji: '🌨️', summary: 'Snow' };
  if (code >= 95) return { emoji: '⛈️', summary: 'Thunderstorm' };
  return { emoji: '🌡️', summary: 'Weather' };
}
async function resolveWeather(city: string, country: string, units: 'celsius' | 'fahrenheit'): Promise<Record<string, string>> {
  const blank = { weather_emoji: '', weather_temp: '', weather_summary: 'Weather unavailable for your location.', weather_location: '' };
  if (!city) return blank;
  try {
    const gp = new URLSearchParams({ name: city.trim(), count: '1', language: 'en', format: 'json' });
    if (country.trim()) gp.set('country', country.trim());
    const gres = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${gp}`);
    const gj = gres.ok ? (await gres.json()) as { results?: Array<{ latitude: number; longitude: number; name: string; country?: string }> } : null;
    const hit = gj?.results?.[0]; if (!hit) return blank;
    const wp = new URLSearchParams({ latitude: String(hit.latitude), longitude: String(hit.longitude), current: 'temperature_2m,weather_code', temperature_unit: units });
    const wres = await fetch(`https://api.open-meteo.com/v1/forecast?${wp}`);
    const wj = wres.ok ? (await wres.json()) as { current?: { temperature_2m?: number; weather_code?: number } } : null;
    const t = wj?.current?.temperature_2m, c = wj?.current?.weather_code;
    if (typeof t !== 'number' || typeof c !== 'number') return blank;
    const { emoji, summary } = weatherEmoji(c);
    return { weather_emoji: emoji, weather_temp: `${Math.round(t)}${units === 'fahrenheit' ? '°F' : '°C'}`, weather_summary: summary, weather_location: `${hit.name}${hit.country ? `, ${hit.country}` : ''}` };
  } catch { return blank; }
}

export const newsletterBinding: SendEngineBinding = {
  domain: 'newsletter',
  sendsTable: 'newsletter_sends',
  recipientsTable: 'newsletter_send_recipients',
  batchesTable: 'newsletter_send_batches',
  logSendIdColumn: 'newsletter_send_id',
  claimRpc: 'claim_due_newsletter_recipients',

  async buildSendContext(deps: EngineDeps, sendId: string): Promise<SendContext | null> {
    const { data: send } = await deps.supabase.from('newsletter_sends').select('*').eq('id', sendId).single();
    if (!send || !send.rendered_html) return null;
    const listId = (send.list_ids || [])[0];
    if (!listId) return null;
    let replyTo: string | null = null;
    if (send.collection_id) {
      const { data: coll } = await deps.supabase.from('newsletters_template_collections').select('reply_to').eq('id', send.collection_id).maybeSingle();
      replyTo = coll?.reply_to || null;
    }
    const html: string = send.rendered_html;
    const subject: string = send.subject || 'Newsletter';
    const usesWeather = /\{\{weather_(emoji|temp|summary|location)\}\}/.test(html);
    const unitMarker = html.match(/<!--gw-weather-units:(celsius|fahrenheit)-->/);
    const ctx: NlCtx = {
      sendId, brand: send.brand || process.env.SEND_ENGINE_DEFAULT_BRAND || 'default', channel: send.channel || 'email',
      subject, html,
      fromEmail: send.from_address || process.env.EMAIL_FROM || 'noreply@localhost',
      fromName: send.from_name || process.env.EMAIL_FROM_NAME || 'Gatewaze',
      replyTo, disableSubscriptionTracking: true,
      listId, hmacSecret: process.env.UNSUBSCRIBE_HMAC_SECRET,
      portalBaseUrl: (send.metadata?.portal_base_url) || process.env.SITE_URL || null,
      tokens: scanTokens(html, subject),
      usesWeather, weatherUnits: unitMarker && unitMarker[1] === 'fahrenheit' ? 'fahrenheit' : 'celsius',
      attrs: new Map(), weatherCache: new Map(),
    };
    return ctx;
  },

  async prepareBatch(deps: EngineDeps, ctx: SendContext, recipients: Recipient[]): Promise<void> {
    const c = ctx as NlCtx;
    const emails = recipients.map((r) => r.email).filter(Boolean) as string[];
    for (let i = 0; i < emails.length; i += 500) {
      const { data } = await deps.supabase.from('people').select('email, attributes').in('email', emails.slice(i, i + 500));
      for (const row of data ?? []) c.attrs.set(row.email, row.attributes ?? {});
    }
  },

  async buildSubstitutions(ctx: SendContext, r: Recipient, headers: Record<string, string>): Promise<Record<string, string>> {
    const c = ctx as NlCtx;
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

    // Unsubscribe URLs + List-Unsubscribe header.
    let unsubUrl = '', manageUrl = '';
    if (c.hmacSecret && r.email) {
      const tok = encodeURIComponent(genUnsubToken(r.email, c.listId, c.hmacSecret));
      const oneClick = `${process.env.SUPABASE_URL || ''}/functions/v1/newsletter-unsubscribe?token=${tok}`;
      const base = c.portalBaseUrl ? c.portalBaseUrl.replace(/\/$/, '') : null;
      unsubUrl = base ? `${base}/subscriptions?token=${tok}&unsub=1` : oneClick;
      manageUrl = base ? `${base}/subscriptions?token=${tok}` : oneClick;
      headers['List-Unsubscribe'] = `<${oneClick}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }

    // Resolve every token present in the rendered HTML/subject to a value.
    const subs: Record<string, string> = {};
    for (const token of c.tokens) {
      const inner = token.slice(2, -2).trim();                 // strip {{ }}
      if (inner === 'unsubscribe_url') { subs[token] = unsubUrl; continue; }
      if (inner === 'manage_subscriptions_url') { subs[token] = manageUrl; continue; }
      if (weather && WEATHER_TOKENS.includes(inner)) { subs[token] = weather[inner] ?? ''; continue; }
      // merge field, optionally `field|fallback`
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
