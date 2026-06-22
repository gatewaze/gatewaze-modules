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
 * Broadcasts have no weather or per-occurrence link tracking (newsletter-only),
 * so this binding is a strict subset of the newsletter binding.
 */
import { createHmac } from 'node:crypto';
import type { EngineDeps, SendContext, SendEngineBinding, Recipient } from '../../bulk-emailing/worker/send-engine/engine.js';

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
      portalBaseUrl: metadata.portal_base_url || process.env.SITE_URL || null,
      supabaseUrl: process.env.SUPABASE_URL || '',
      tokens: scanTokens(html, subject),
      usesMergeFields: htmlUsesMergeFields(html) || htmlUsesMergeFields(subject),
      attrs: new Map(),
    };
    return ctx;
  },

  async prepareBatch(deps: EngineDeps, ctx: SendContext, recipients: Recipient[]): Promise<void> {
    const c = ctx as BcCtx;
    if (!c.usesMergeFields) return;
    const emails = recipients.map((r) => r.email).filter(Boolean) as string[];
    for (let i = 0; i < emails.length; i += 500) {
      const { data } = await deps.supabase.from('people').select('email, attributes').in('email', emails.slice(i, i + 500));
      for (const row of data ?? []) c.attrs.set(row.email, row.attributes ?? {});
    }
  },

  async buildSubstitutions(ctx: SendContext, r: Recipient, headers: Record<string, string>): Promise<Record<string, string>> {
    const c = ctx as BcCtx;
    const attrs = (r.email && c.attrs.get(r.email)) || {};
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
    const nameVal = () => [str(attrs.first_name), str(attrs.last_name)].filter(Boolean).join(' ');

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
