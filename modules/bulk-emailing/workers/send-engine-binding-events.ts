/**
 * Event-communications binding for the Central Sending Service engine (the
 * fourth consumer, after newsletters / broadcasts / bulk). Maps the generic
 * worker drip engine onto email_batch_jobs + email_batch_job_recipients.
 *
 * Unlike the broadcast/newsletter bindings (which load people.attributes per
 * batch and substitute a fixed merge-field set), event comms enqueues each
 * recipient's FULL substitution context as jsonb at fan-out time (the
 * email-batch-send edge fn reuses its battle-tested per-audience resolution to
 * build it). So this binding has no prepareBatch — it resolves the stored,
 * SCOPED tokens ({{customer.first_name}}, {{event.name}}, {{speaker.talk_title}},
 * {{calendar.google}}, with `| default:"..."`) straight from r.context, matching
 * the edge fn's replaceVariables exactly.
 *
 * Unsubscribe is tied to the global "Event Updates" list (slug 'event-updates'),
 * per the list-tied-send model — reusing the shared list-unsubscribe (the
 * newsletter-unsubscribe edge fn + portal Subscription Centre), same as
 * broadcasts.
 */
import { createHmac } from 'node:crypto';
import type { EngineDeps, SendContext, SendEngineBinding, Recipient } from '../worker/send-engine/engine.js';

type EvCtx = SendContext & {
  listId: string | null;            // 'event-updates' list id (unsubscribe target)
  hmacSecret?: string;
  portalBaseUrl: string | null;
  supabaseUrl: string;
  tokens: string[];                 // exact {{...}} strings in html+subject
};

function scanTokens(html: string, subject: string): string[] {
  const set = new Set<string>();
  const re = /\{\{[^}]+\}\}/g;
  for (const s of [html, subject]) { let m; while ((m = re.exec(s))) set.add(m[0]); }
  return [...set];
}

// List-based unsubscribe token (email:list_id:timestamp) — same shape as
// newsletters/broadcasts, so event comms reuses the shared list-unsubscribe.
function genUnsubToken(email: string, listId: string, secret: string): string {
  const payload = `${email}:${listId}:${Date.now()}`;
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

// Resolve a single {{scope.field | default:"x"}} token from the stored
// TemplateContext. Returns null when the token isn't a scoped variable (e.g.
// unsubscribe_url, which the caller handles separately). Mirrors the edge fn's
// replaceVariables (no HTML-escaping — SendGrid substitutions insert raw, as the
// inline Tier-1 path did).
function resolveScoped(token: string, context: Record<string, Record<string, unknown> | undefined>): string | null {
  const inner = token.slice(2, -2).trim();
  const segments = inner.split('|').map((s) => s.trim());
  const m = segments[0].match(/^([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)(?::([a-zA-Z0-9_-]+))?$/);
  if (!m) return null;
  const [, scope, field] = m;
  let def: string | undefined;
  for (let i = 1; i < segments.length; i++) {
    const f = segments[i].match(/^default:"([^"]*)"$/);
    if (f) def = f[1];
  }
  const v = context?.[scope]?.[field];
  if (v !== undefined && v !== null && v !== '') return String(v);
  return def ?? '';
}

export const eventCommsBinding: SendEngineBinding = {
  domain: 'event',
  sendsTable: 'email_batch_jobs',
  recipientsTable: 'email_batch_job_recipients',
  batchesTable: 'email_batch_job_batches',
  logSendIdColumn: 'batch_job_id',
  claimRpc: 'claim_due_email_batch_recipients',

  async buildSendContext(deps: EngineDeps, sendId: string): Promise<SendContext | null> {
    const { data: job } = await deps.supabase.from('email_batch_jobs').select('*').eq('id', sendId).single();
    if (!job || !job.content_template) return null;

    const subject: string = job.subject_template || 'Message';
    let html: string = job.content_template;

    // Inject the unsubscribe footer once (the batch body carries the tokens;
    // SendGrid substitutes per recipient) unless the content already has one.
    if (!/\{\{unsubscribe_url\}\}/.test(html)) {
      const footer =
        `<div style="text-align:center;padding:20px;font-size:12px;color:#999;">` +
        `<a href="{{unsubscribe_url}}" style="color:#999;">Unsubscribe</a> &middot; ` +
        `<a href="{{manage_subscriptions_url}}" style="color:#999;">Manage your email preferences</a></div>`;
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${footer}</body>`) : html + footer;
    }

    // The global "Event Updates" list is the unsubscribe category for event comms.
    const { data: list } = await deps.supabase.from('lists').select('id').eq('slug', 'event-updates').maybeSingle();

    // From: "Name - email@x" or a bare address (matches the edge fn's parse).
    let fromEmail: string = job.from_address || '';
    let fromName: string | undefined;
    const fm = (job.from_address || '').match(/^(.+?)\s*-\s*(.+@.+)$/);
    if (fm) { fromName = fm[1].trim(); fromEmail = fm[2].trim(); }

    const ctx: EvCtx = {
      sendId,
      brand: process.env.SEND_ENGINE_DEFAULT_BRAND || 'default',
      channel: 'email',
      subject, html,
      fromEmail: fromEmail || process.env.BULK_EMAIL_FROM_ADDRESS || process.env.EMAIL_FROM || 'noreply@localhost',
      fromName: fromName || process.env.BULK_EMAIL_FROM_NAME || process.env.EMAIL_FROM_NAME || 'Gatewaze',
      replyTo: job.reply_to || null,
      disableSubscriptionTracking: true,
      listId: list?.id || null,
      hmacSecret: process.env.UNSUBSCRIBE_HMAC_SECRET,
      portalBaseUrl: process.env.SITE_URL || null,
      supabaseUrl: process.env.SUPABASE_URL || '',
      tokens: scanTokens(html, subject),
    };
    return ctx;
  },

  // No prepareBatch — each recipient's substitution context was captured at
  // fan-out time and travels on the queue row (r.context).

  async buildSubstitutions(ctx: SendContext, r: Recipient, headers: Record<string, string>): Promise<Record<string, string>> {
    const c = ctx as EvCtx;
    // The claimed queue row carries the per-recipient context jsonb (not in the
    // engine's Recipient type — it returns r.*, so read it off the row).
    const context = ((r as unknown as { context?: Record<string, Record<string, unknown> | undefined> }).context) || {};

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
      const inner = token.slice(2, -2).trim();
      if (inner === 'unsubscribe_url') { subs[token] = unsubUrl; continue; }
      if (inner === 'manage_subscriptions_url') { subs[token] = manageUrl; continue; }
      const v = resolveScoped(token, context);
      if (v !== null) subs[token] = v;
    }
    return subs;
  },
};
