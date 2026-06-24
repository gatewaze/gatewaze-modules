/**
 * Bulk binding for the Central Sending Service engine (Phase 3 — the third
 * consumer). Maps the generic worker drip engine onto email_batch_jobs (kept as
 * the bulk "send" row per spec) + the bulk_send_recipients queue.
 *
 * Content model differs from newsletters/broadcasts: a bulk job has no single
 * rendered_html — it carries subject_template + content_template with
 * `{{scope.field|default:"..."}}` tokens, rendered per recipient against a
 * per-recipient context. So the binding scans those tokens and resolves each
 * from the recipient's bulk_send_recipients.template_variables (the same context
 * shape the Edge email-batch-send builds), exactly mirroring the Edge's
 * replaceVariables() — tokens with no match are left literal (SendGrid leaves an
 * unsubstituted {{token}} as-is).
 *
 * Active path: a job is fanned out into bulk_send_recipients by the producer
 * (e.g. email-batch-send Edge fn's enqueueAllRecipients), and this binding
 * resolves each row's substitutions against its template_variables. The
 * legacy synchronous email-batch-send inline loop has been removed.
 */
import type { EngineDeps, SendContext, SendEngineBinding, Recipient } from '../worker/send-engine/engine.js';

type TemplateContext = Record<string, Record<string, unknown> | undefined>;

type BulkCtx = SendContext & {
  tokens: string[];                       // exact {{...}} strings in subject+content
  vars: Map<string, TemplateContext>;     // recipient id -> per-recipient context
};

// Mirror of the Edge replaceVariables() field grammar: scope.field[:variant][|default:"..."].
const FIELD_RE = /^([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)(?::[a-zA-Z0-9_-]+)?$/;

function scanTokens(...texts: string[]): string[] {
  const set = new Set<string>();
  const re = /\{\{[^}]+\}\}/g;
  for (const s of texts) { let m; while ((m = re.exec(s))) set.add(m[0]); }
  return [...set];
}

// Resolve one {{...}} token against a recipient context, returning the
// substitution value or null when the token doesn't match the grammar (so the
// caller omits it and SendGrid leaves the literal token in place — Edge parity).
function resolveToken(inner: string, ctx: TemplateContext): string | null {
  const trimmed = inner.trim();
  const segments = trimmed.split('|').map((s) => s.trim());
  const fieldMatch = segments[0].match(FIELD_RE);
  if (!fieldMatch) return null;
  const [, scope, field] = fieldMatch;
  const value = ctx[scope]?.[field];
  let defaultValue: string | undefined;
  for (let i = 1; i < segments.length; i++) {
    const dm = segments[i].match(/^default:"([^"]*)"$/);
    if (dm) defaultValue = dm[1];
  }
  if (value !== undefined && value !== null && value !== '') return String(value);
  return defaultValue ?? '';
}

export const bulkBinding: SendEngineBinding = {
  domain: 'bulk',
  sendsTable: 'email_batch_jobs',
  recipientsTable: 'bulk_send_recipients',
  batchesTable: 'bulk_send_batches',
  logSendIdColumn: 'bulk_send_id',
  claimRpc: 'claim_due_bulk_recipients',

  async buildSendContext(deps: EngineDeps, sendId: string): Promise<SendContext | null> {
    const { data: job } = await deps.supabase.from('email_batch_jobs').select('*').eq('id', sendId).single();
    if (!job) return null;
    const subject: string = job.subject_template || 'Message';
    const html: string = job.content_template || '';
    if (!html) return null;
    const ctx: BulkCtx = {
      sendId,
      brand: job.brand || process.env.SEND_ENGINE_DEFAULT_BRAND || 'default',
      channel: job.channel || 'email',
      subject, html,
      fromEmail: job.from_address || job.from_email || process.env.BULK_EMAIL_FROM_ADDRESS || process.env.EMAIL_FROM || 'noreply@localhost',
      fromName: process.env.BULK_EMAIL_FROM_NAME || process.env.EMAIL_FROM_NAME || 'Gatewaze',
      replyTo: job.reply_to || null,
      disableSubscriptionTracking: true,
      tokens: scanTokens(html, subject),
      vars: new Map(),
    };
    return ctx;
  },

  // Bulk-load each recipient's per-recipient template context for this batch.
  async prepareBatch(deps: EngineDeps, ctx: SendContext, recipients: Recipient[]): Promise<void> {
    const c = ctx as BulkCtx;
    const ids = recipients.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 500) {
      const { data } = await deps.supabase
        .from('bulk_send_recipients')
        .select('id, template_variables')
        .in('id', ids.slice(i, i + 500));
      for (const row of data ?? []) c.vars.set(row.id, (row.template_variables ?? {}) as TemplateContext);
    }
  },

  async buildSubstitutions(ctx: SendContext, r: Recipient, _headers: Record<string, string>): Promise<Record<string, string>> {
    const c = ctx as BulkCtx;
    const rc = c.vars.get(r.id) ?? {};
    const subs: Record<string, string> = {};
    for (const token of c.tokens) {
      const val = resolveToken(token.slice(2, -2), rc);   // strip {{ }}
      if (val !== null) subs[token] = val;                // unmatched → leave literal (Edge parity)
    }
    return subs;
  },
};
