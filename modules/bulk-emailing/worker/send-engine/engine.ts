/**
 * Central Sending Service — generic worker-side drip engine (Tier 2 generalised).
 *
 * Runs in the Node `aaif-worker`. Table-parametric over a `SendEngineBinding`
 * (newsletter / broadcast / bulk), so one engine serves all domains. Per tick:
 *   sweep stuck rows → recover 'posting' batches → claim due recipients →
 *   group by send → (quota gate, bounce gate) → sendBatch → record → finalise.
 *
 * Throughput model + guardrails per spec-central-sending-service.md (which
 * generalises spec-newsletter-tier2-throughput.md). NOTE: the worker calls
 * SendGrid directly (Node `fetch` + process.env) — the Deno edge provider can't
 * run in Node; see ./sendgrid.ts. Atomicity uses sequential writes + the
 * recovery layer (idempotent), not a cross-call transaction.
 *
 * Flag-gated: nothing here runs until SEND_ENGINE_USE_WORKER=true wires a
 * domain's dispatch cron to runDripTick.
 */
import { randomUUID } from 'node:crypto';
import { sendBatchViaSendgrid, queryBatchAccepted } from './sendgrid.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = any; // @supabase/supabase-js client (service role), injected by the worker

export interface Recipient { id: string; send_id: string; person_id: string | null; email: string | null; timezone: string | null; }
export interface SendContext {
  sendId: string; brand: string; channel: string;
  subject: string; html: string;
  fromEmail: string; fromName: string; replyTo: string | null;
  // Returns the per-recipient SendGrid substitution map (token -> value), e.g.
  // '{{first_name}}' -> 'Dan', '{{unsubscribe_url}}' -> '...'. The binding owns
  // token shape + content; the engine just passes it through.
  disableSubscriptionTracking?: boolean;
}
export interface SendEngineBinding {
  domain: 'newsletter' | 'broadcast' | 'bulk';
  sendsTable: string;
  recipientsTable: string;
  batchesTable: string;
  logSendIdColumn: string;        // email_send_log.<col>
  claimRpc: string;               // claim_due_<domain>_recipients(p_limit)
  buildSendContext: (deps: EngineDeps, sendId: string) => Promise<SendContext | null>;
  // Called once per batch BEFORE building personalizations — bulk-load anything
  // per-recipient (e.g. people.attributes for merge fields) into a binding-owned
  // cache, so buildSubstitutions stays fast.
  prepareBatch?: (deps: EngineDeps, ctx: SendContext, recipients: Recipient[]) => Promise<void>;
  buildSubstitutions: (ctx: SendContext, r: Recipient, perRecipientHeaders: Record<string, string>) => Promise<Record<string, string>>;
  // Per-recipient List-Unsubscribe etc. (binding fills perRecipientHeaders).
  recipientHeaders?: (ctx: SendContext, r: Recipient) => Promise<Record<string, string>>;
}
export interface EngineDeps {
  supabase: SB;
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  config: {
    claimBatch: number;          // rows per claim (== batch size); default 1000
    batchSize: number;           // personalizations per SendGrid call; default 1000
    budgetMs: number;            // drip budget within the tick; default 45000
    dailyCap: number;            // per-brand daily cap; default very large
    rampPercent: number;         // IP-warmup throttle 0..100; default 100
    replica: string;
  };
}

const BOUNCE_RATE_TRIP = 0.08;   // fast gate: >8% bounced in last 60s -> pause
const SPAM_RATE_TRIP = 0.005;    // >0.5% spam in last 60s -> pause

function chunk<T>(a: T[], n: number): T[][] { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

export async function runDripTick(deps: EngineDeps, binding: SendEngineBinding): Promise<{ claimed: number; sent: number; failed: number }> {
  const { supabase, logger, config } = deps;
  const start = Date.now();
  let claimedTotal = 0, sentTotal = 0, failedTotal = 0;

  // 1. Release rows stuck in 'sending' from a prior crashed tick.
  // (supabase.rpc returns a PostgREST thenable with no .catch — use {error}.)
  const { error: sweepErr } = await supabase.rpc('release_stuck_send_rows', { p_recipients_table: binding.recipientsTable, p_stale_after: '15 minutes' });
  if (sweepErr) logger.warn('[send-engine] sweeper failed', sweepErr);
  // 2. Crash recovery for 'posting' batches (202-but-commit-failed window).
  await recoverPostingBatches(deps, binding).catch((e: unknown) => logger.warn('[send-engine] recovery failed', e));

  const ctxCache = new Map<string, SendContext | null>();
  const touched = new Set<string>();

  while (Date.now() - start < config.budgetMs) {
    const { data: claimed, error } = await supabase.rpc(binding.claimRpc, { p_limit: config.claimBatch });
    if (error) { logger.error('[send-engine] claim failed', error); break; }
    const rows: Recipient[] = claimed ?? [];
    if (rows.length === 0) break;
    claimedTotal += rows.length;

    const bySend = new Map<string, Recipient[]>();
    for (const r of rows) { (bySend.get(r.send_id) ?? bySend.set(r.send_id, []).get(r.send_id)!).push(r); }

    for (const [sendId, recips] of bySend) {
      touched.add(sendId);
      const { data: send } = await supabase.from(binding.sendsTable).select('*').eq('id', sendId).single();
      if (!send) { await releaseRows(deps, binding, recips.map((r) => r.id)); continue; }
      if (send.status === 'cancelling' || send.status === 'cancelled') { await markRows(deps, binding, recips.map((r) => r.id), 'skipped'); continue; }
      if (send.status === 'paused') { await releaseRows(deps, binding, recips.map((r) => r.id)); continue; }

      let ctx = ctxCache.get(sendId);
      if (ctx === undefined) { ctx = await binding.buildSendContext(deps, sendId); ctxCache.set(sendId, ctx); }
      if (!ctx) { await releaseRows(deps, binding, recips.map((r) => r.id)); continue; }   // no content yet — retry next tick

      for (const batch of chunk(recips, config.batchSize)) {
        // Fast bounce/spam gate (last 60s for this send).
        if (await shouldAbortForReputation(deps, binding, sendId)) {
          await releaseRows(deps, binding, batch.map((r) => r.id));
          await supabase.from(binding.sendsTable).update({ status: 'paused', updated_at: new Date().toISOString() }).eq('id', sendId);
          logger.warn('[send-engine] reputation gate tripped; paused', { sendId });
          break;
        }
        // Quota: claim per the send's brand/channel; trim/abort if short.
        const want = Math.floor(batch.length * (config.rampPercent / 100)) || batch.length;
        const { data: granted } = await supabase.rpc('claim_drip_quota', { p_brand: send.brand ?? 'default', p_channel: send.channel ?? 'email', p_request: want, p_daily_cap: config.dailyCap });
        const grant = typeof granted === 'number' ? granted : want;
        if (grant <= 0) { await releaseRows(deps, binding, batch.map((r) => r.id)); break; }
        const slice = batch.slice(0, grant);
        if (slice.length < batch.length) await releaseRows(deps, binding, batch.slice(grant).map((r) => r.id));

        const out = await postBatch(deps, binding, ctx, send, slice);
        sentTotal += out.sent; failedTotal += out.failed;
      }
    }
  }

  for (const sendId of touched) await finalizeSend(deps, binding, sendId).catch((e) => logger.warn('[send-engine] finalize failed', e));
  return { claimed: claimedTotal, sent: sentTotal, failed: failedTotal };
}

async function postBatch(deps: EngineDeps, binding: SendEngineBinding, ctx: SendContext, send: any, recips: Recipient[]): Promise<{ sent: number; failed: number }> {
  const { supabase, logger, config } = deps;
  // Pre-generate email_send_log ids so custom_args carries recipient_log_id
  // (the webhook maps events back to the right log row).
  const logIds = new Map<string, string>(recips.map((r) => [r.id, randomUUID()]));

  // Batch row first ('posting') — recovery anchor if we crash mid-post.
  const { data: batchRow } = await supabase.from(binding.batchesTable).insert({
    send_id: ctx.sendId, worker_replica: config.replica, recipient_count: recips.length, status: 'posting',
  }).select('id').single();
  const batchId = batchRow?.id as string | undefined;

  // Build personalizations.
  if (binding.prepareBatch) await binding.prepareBatch(deps, ctx, recips);
  const personalizations = [];
  for (const r of recips) {
    if (!r.email) continue;
    const headers: Record<string, string> = {};
    if (binding.recipientHeaders) Object.assign(headers, await binding.recipientHeaders(ctx, r));
    const substitutions = await binding.buildSubstitutions(ctx, r, headers);
    personalizations.push({ to: r.email, headers: Object.keys(headers).length ? headers : undefined, substitutions,
      customArgs: { [binding.logSendIdColumn]: ctx.sendId, recipient_log_id: logIds.get(r.id)! } });
  }

  const result = await sendBatchViaSendgrid({
    from: ctx.fromEmail, fromName: ctx.fromName, replyTo: ctx.replyTo ?? undefined,
    subject: ctx.subject, html: ctx.html, disableSubscriptionTracking: ctx.disableSubscriptionTracking,
    personalizations,
  });

  if (result.success) {
    // Sequential accept (idempotent): mark recipients sent + batch_id, insert
    // email_send_log rows, finalise batch row. Recovery covers a crash here.
    const ids = recips.map((r) => r.id);
    await supabase.from(binding.recipientsTable).update({ status: 'sent', batch_id: batchId, updated_at: new Date().toISOString() }).in('id', ids);
    const logRows = recips.filter((r) => r.email).map((r) => ({
      id: logIds.get(r.id), recipient_email: r.email, from_address: ctx.fromEmail, reply_to: ctx.replyTo,
      subject: ctx.subject, provider: 'sendgrid', [binding.logSendIdColumn]: ctx.sendId,
      status: 'sent', sent_at: new Date().toISOString(), provider_message_id: result.batchMessageId ?? null,
    }));
    await supabase.from('email_send_log').upsert(logRows, { onConflict: 'id', ignoreDuplicates: true });
    await supabase.from(binding.batchesTable).update({ status: 'accepted', provider_batch_id: result.batchMessageId ?? null, http_status: 200, completed_at: new Date().toISOString() }).eq('id', batchId);
    return { sent: recips.length, failed: 0 };
  }

  // Failure: retryable -> release to pending; terminal -> mark failed.
  logger.warn('[send-engine] batch failed', { sendId: ctx.sendId, error: result.error, retryable: result.retryable });
  if (result.retryable) await releaseRows(deps, binding, recips.map((r) => r.id));
  else await markRows(deps, binding, recips.map((r) => r.id), 'failed');
  await supabase.from(binding.batchesTable).update({ status: result.retryable ? 'failed' : 'rejected', http_status: result.statusCode ?? null, error_summary: (result.error ?? '').slice(0, 500), completed_at: new Date().toISOString() }).eq('id', batchId);
  return { sent: 0, failed: result.retryable ? 0 : recips.length };
}

async function recoverPostingBatches(deps: EngineDeps, binding: SendEngineBinding): Promise<void> {
  const { supabase } = deps;
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  const { data: stuck } = await supabase.from(binding.batchesTable).select('id, send_id, provider_batch_id, posted_at, recipient_count').eq('status', 'posting').lt('posted_at', cutoff).limit(50);
  for (const b of stuck ?? []) {
    if (!b.provider_batch_id) { await releaseBatchRecipients(deps, binding, b.id); continue; } // never reached SG
    const r = await queryBatchAccepted(b.provider_batch_id, new Date(b.posted_at)).catch(() => ({ accepted: false, notSeen: false }));
    if (r.accepted) {
      await supabase.from(binding.recipientsTable).update({ status: 'sent', updated_at: new Date().toISOString() }).eq('batch_id', b.id).eq('status', 'sending');
      await supabase.from(binding.batchesTable).update({ status: 'accepted', completed_at: new Date().toISOString() }).eq('id', b.id);
    } else if (r.notSeen && new Date(b.posted_at).getTime() < Date.now() - 10 * 60_000) {
      await releaseBatchRecipients(deps, binding, b.id);
    } // else: unknown / too soon -> leave for next tick
  }
}

async function releaseBatchRecipients(deps: EngineDeps, binding: SendEngineBinding, batchId: string): Promise<void> {
  await deps.supabase.from(binding.recipientsTable).update({ status: 'pending', batch_id: null, updated_at: new Date().toISOString() }).eq('batch_id', batchId).eq('status', 'sending');
  await deps.supabase.from(binding.batchesTable).update({ status: 'failed', completed_at: new Date().toISOString() }).eq('id', batchId);
}

async function shouldAbortForReputation(deps: EngineDeps, binding: SendEngineBinding, sendId: string): Promise<boolean> {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { data } = await deps.supabase.from('email_send_log').select('status').eq(binding.logSendIdColumn, sendId).gt('sent_at', since);
  const rows = data ?? [];
  if (rows.length < 50) return false; // not enough signal
  const bounced = rows.filter((r: any) => r.status === 'bounced').length / rows.length;
  const spam = rows.filter((r: any) => r.status === 'spam_reported').length / rows.length;
  return bounced > BOUNCE_RATE_TRIP || spam > SPAM_RATE_TRIP;
}

async function releaseRows(deps: EngineDeps, binding: SendEngineBinding, ids: string[]): Promise<void> {
  if (ids.length) await deps.supabase.from(binding.recipientsTable).update({ status: 'pending', updated_at: new Date().toISOString() }).in('id', ids);
}
async function markRows(deps: EngineDeps, binding: SendEngineBinding, ids: string[], status: string): Promise<void> {
  if (ids.length) await deps.supabase.from(binding.recipientsTable).update({ status, updated_at: new Date().toISOString() }).in('id', ids);
}

async function finalizeSend(deps: EngineDeps, binding: SendEngineBinding, sendId: string): Promise<void> {
  const { supabase } = deps;
  const head = async (statuses: string[]) => {
    const { count } = await supabase.from(binding.recipientsTable).select('id', { count: 'exact', head: true }).eq('send_id', sendId).in('status', statuses);
    return count ?? 0;
  };
  const [remaining, sent, failed] = await Promise.all([head(['pending', 'sending']), head(['sent']), head(['failed'])]);
  const patch: Record<string, unknown> = { sent_count: sent, failed_count: failed, updated_at: new Date().toISOString() };
  if (remaining === 0) {
    const { data: send } = await supabase.from(binding.sendsTable).select('status').eq('id', sendId).single();
    patch.status = send?.status === 'cancelling' ? 'cancelled' : (sent === 0 && failed > 0 ? 'failed' : 'sent');
    patch.completed_at = new Date().toISOString();
  }
  await supabase.from(binding.sendsTable).update(patch).eq('id', sendId);
}
