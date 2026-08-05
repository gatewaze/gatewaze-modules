// @ts-nocheck — depends on supabase-js; resolved at worker-host install time.

/**
 * Plays binding for the Central Sending Service engine (spec-plays-scheduling-
 * automation §4.2). The third consumer after newsletters + broadcasts. Co-located
 * with the broadcast binding to reuse its helpers/conventions; a fan-out
 * communication Play delivers to a signals_audiences snapshot through the SAME
 * runDripTick/claim/drip path — no new engine, no new drip loop.
 *
 * Content: plays_sends.content_ref carries the rendered body. For the initial
 * message capabilities it is `{ inline: { subject, html } }` (the fan-out worker
 * renders once and stores it); a `{ module, type, id }` pointer (e.g. a broadcast
 * row) can be resolved later. The batch body keeps the literal {{tokens}};
 * SendGrid substitutes per recipient via `substitutions`.
 */

import { createHmac } from 'node:crypto';

const MERGE_FIELDS = ['first_name', 'last_name', 'name', 'company', 'job_title'];
const MERGE_GROUP = MERGE_FIELDS.join('|');

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function unquote(fb) {
  const t = String(fb).trim();
  return (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) ? t.slice(1, -1) : t;
}
function scanTokens(html, subject) {
  const set = new Set();
  const re = /\{\{[^}]+\}\}/g;
  for (const s of [html || '', subject || '']) { let m; while ((m = re.exec(s))) set.add(m[0]); }
  return [...set];
}
function htmlUsesMergeFields(s) { return new RegExp(`\\{\\{\\s*(?:${MERGE_GROUP})\\b`).test(s || ''); }
// List-based unsubscribe token — same shape as newsletters/broadcasts.
function genUnsubToken(email, listId, secret) {
  const payload = `${email}:${listId}:${Date.now()}`;
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

export const playsBinding = {
  domain: 'play',
  sendsTable: 'plays_sends',
  recipientsTable: 'plays_send_recipients',
  batchesTable: 'plays_send_batches',
  logSendIdColumn: 'plays_send_id',
  claimRpc: 'claim_due_plays_recipients',

  async buildSendContext(deps, sendId) {
    const { data: send } = await deps.supabase.from('plays_sends').select('*').eq('id', sendId).single();
    if (!send) return null;
    const ref = send.content_ref || {};
    let subject = 'Message';
    let html = '';
    if (ref.inline) { subject = ref.inline.subject || subject; html = ref.inline.html || ''; }
    else if (ref.module === 'broadcasts' && ref.id) {
      const { data: bc } = await deps.supabase.from('broadcasts').select('subject,rendered_html').eq('id', ref.id).maybeSingle();
      if (bc) { subject = bc.subject || subject; html = bc.rendered_html || ''; }
    }
    if (!html) return null;

    // Inject the unsubscribe footer once (batch body carries the tokens).
    if (!/\{\{unsubscribe_url\}\}/.test(html)) {
      const footer =
        `<div style="text-align:center;padding:20px;font-size:12px;color:#999;">` +
        `<a href="{{unsubscribe_url}}" style="color:#999;">Unsubscribe</a> &middot; ` +
        `<a href="{{manage_subscriptions_url}}" style="color:#999;">Manage your email preferences</a></div>`;
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${footer}</body>`) : html + footer;
    }

    const portalBaseUrl = process.env.SITE_URL || null;
    return {
      sendId,
      brand: send.brand || process.env.SEND_ENGINE_DEFAULT_BRAND || 'default',
      channel: send.channel || 'email',
      subject, html,
      fromEmail: process.env.BULK_EMAIL_FROM_ADDRESS || process.env.EMAIL_FROM || 'noreply@localhost',
      fromName: process.env.BULK_EMAIL_FROM_NAME || process.env.EMAIL_FROM_NAME || 'Gatewaze',
      replyTo: null,
      disableSubscriptionTracking: true,
      // binding-private:
      listId: send.category_list_id || null,
      suppressionTopic: send.suppression_topic || 'plays',
      hmacSecret: process.env.UNSUBSCRIBE_HMAC_SECRET,
      portalBaseUrl,
      supabaseUrl: process.env.SUPABASE_URL || '',
      tokens: scanTokens(html, subject),
      usesMergeFields: htmlUsesMergeFields(html) || htmlUsesMergeFields(subject),
      attrs: new Map(),
    };
  },

  async prepareBatch(deps, ctx, recipients) {
    if (!ctx.usesMergeFields) return;
    const emails = recipients.map((r) => r.email).filter(Boolean);
    for (let i = 0; i < emails.length; i += 500) {
      const { data } = await deps.supabase.from('people').select('email, attributes').in('email', emails.slice(i, i + 500));
      for (const row of data ?? []) ctx.attrs.set(row.email, row.attributes ?? {});
    }
  },

  async buildSubstitutions(ctx, r, headers) {
    const attrs = (r.email && ctx.attrs.get(r.email)) || {};
    const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
    const nameVal = () => [str(attrs.first_name), str(attrs.last_name)].filter(Boolean).join(' ');

    let unsubUrl = '', manageUrl = '';
    if (ctx.hmacSecret && r.email && ctx.listId) {
      const tok = encodeURIComponent(genUnsubToken(r.email, ctx.listId, ctx.hmacSecret));
      const oneClick = `${ctx.supabaseUrl}/functions/v1/newsletter-unsubscribe?token=${tok}`;
      const base = ctx.portalBaseUrl ? ctx.portalBaseUrl.replace(/\/$/, '') : null;
      unsubUrl = base ? `${base}/subscriptions?token=${tok}&unsub=1` : oneClick;
      manageUrl = base ? `${base}/subscriptions?token=${tok}` : oneClick;
      headers['List-Unsubscribe'] = `<${oneClick}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }

    const subs = {};
    for (const token of ctx.tokens) {
      const inner = token.slice(2, -2).trim();
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

export default { playsBinding };
