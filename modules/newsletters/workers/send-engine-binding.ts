/**
 * Newsletter binding for the Central Sending Service engine (the first consumer
 * / Tier 2 canary). Maps the generic engine onto newsletter_sends.
 *
 * Phase 1 scope: plain `{{first_name}}` etc. merge tokens + per-recipient
 * unsubscribe (HMAC). NOT yet ported to the worker path (so the canary should
 * start with editions that don't use them): weather substitution, block-level
 * link tracking, and `{{field|fallback}}` syntax — these need the `forSendBatched`
 * render (`-merge:token-`) per spec-newsletter-tier2-throughput.md. Until then,
 * editions using those should stay on the Edge drip (flag off).
 */
import { createHmac } from 'node:crypto';
import type { EngineDeps, SendContext, SendEngineBinding, Recipient } from '../../bulk-emailing/worker/send-engine/engine.js';

const MERGE_FIELDS = ['first_name', 'last_name', 'name', 'company', 'job_title'] as const;

// ctx + a per-batch attribute cache (binding-owned; populated by prepareBatch).
type NlCtx = SendContext & { listId: string; hmacSecret?: string; portalBaseUrl: string | null; attrs: Map<string, Record<string, unknown>> };

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function genUnsubToken(email: string, listId: string, secret: string): string {
  const payload = `${email}:${listId}:${Date.now()}`;
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
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
    const ctx: NlCtx = {
      sendId, brand: send.brand || process.env.SEND_ENGINE_DEFAULT_BRAND || 'default', channel: send.channel || 'email',
      subject: send.subject || 'Newsletter', html: send.rendered_html,
      fromEmail: send.from_address || process.env.EMAIL_FROM || 'noreply@localhost',
      fromName: send.from_name || process.env.EMAIL_FROM_NAME || 'Gatewaze',
      replyTo, disableSubscriptionTracking: true,
      listId, hmacSecret: process.env.UNSUBSCRIBE_HMAC_SECRET,
      portalBaseUrl: (send.metadata?.portal_base_url) || process.env.SITE_URL || null,
      attrs: new Map(),
    };
    return ctx;
  },

  async prepareBatch(deps: EngineDeps, ctx: SendContext, recipients: Recipient[]): Promise<void> {
    const c = ctx as NlCtx;
    const emails = recipients.map((r) => r.email).filter(Boolean) as string[];
    for (let i = 0; i < emails.length; i += 500) {
      const chunk = emails.slice(i, i + 500);
      const { data } = await deps.supabase.from('people').select('email, attributes').in('email', chunk);
      for (const row of data ?? []) c.attrs.set(row.email, row.attributes ?? {});
    }
  },

  async buildSubstitutions(ctx: SendContext, r: Recipient, headers: Record<string, string>): Promise<Record<string, string>> {
    const c = ctx as NlCtx;
    const subs: Record<string, string> = {};
    const attrs = (r.email && c.attrs.get(r.email)) || {};
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
    for (const f of MERGE_FIELDS) {
      const val = f === 'name' ? [str(attrs.first_name), str(attrs.last_name)].filter(Boolean).join(' ') : str(attrs[f]);
      subs[`{{${f}}}`] = escapeHtml(val);
    }
    if (c.hmacSecret && r.email) {
      const tok = encodeURIComponent(genUnsubToken(r.email, c.listId, c.hmacSecret));
      const supaUrl = process.env.SUPABASE_URL || '';
      const oneClick = `${supaUrl}/functions/v1/newsletter-unsubscribe?token=${tok}`;
      const base = c.portalBaseUrl ? c.portalBaseUrl.replace(/\/$/, '') : null;
      subs['{{unsubscribe_url}}'] = base ? `${base}/subscriptions?token=${tok}&unsub=1` : oneClick;
      subs['{{manage_subscriptions_url}}'] = base ? `${base}/subscriptions?token=${tok}` : oneClick;
      headers['List-Unsubscribe'] = `<${oneClick}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    return subs;
  },
};
