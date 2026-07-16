import type { Job } from 'bullmq';
// Static (not dynamic) import: a bare-specifier `await import('@supabase/...')`
// from this module-file location does not resolve in the worker runtime
// (ERR_MODULE_NOT_FOUND), whereas a top-level import does — matching every
// other module worker (ai/*, calendars, newsletters/list-hygiene).
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface DispatchJobData {
  kind: string;
}

interface DueSend {
  id: string;
}

/**
 * Heartbeat that fires due scheduled newsletter sends + drives the per-recipient
 * drip.
 *
 * Scheduling is DB-as-source-of-truth: a scheduled send is just a
 * `newsletter_sends` row with `status='scheduled'` and a `scheduled_at`. This
 * 60s BullMQ cron is the pg_cron stand-in that works on every deploy target
 * (Docker, k8s, cloud + self-hosted Supabase) without relying on pg_cron /
 * pg_net.
 *
 * Per-tick sequence (in order):
 *   1. Select due `status='scheduled'` rows (scheduled_at <= now()).
 *   2. For each: call `fanout_newsletter_send_recipients` to populate the
 *      per-recipient timing queue, then flip the send to 'sending' (or
 *      'failed' if fanout errors).
 *   3. Run a drip tick over the shared high-throughput send engine — picks
 *      up any due recipient rows (including ones just fanned out in step 2
 *      for the 'global' strategy where send_at = now() per migration 054).
 *
 * Overlapping ticks are safe — the status flip plus the `FOR UPDATE SKIP
 * LOCKED` recipient claim guard against double-sends.
 */
export default async function handleDispatchScheduled(_job: Job<DispatchJobData>) {
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Find due scheduled sends.
  let processed = 0;
  const errors: string[] = [];
  const { data: due, error: selectErr } = await supabase
    .from('newsletter_sends')
    .select('id')
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at')
    .limit(10);

  if (selectErr) {
    // Throw so BullMQ records the failure and retries on the next tick.
    throw new Error(`[newsletter:dispatch-scheduled] select due sends failed: ${selectErr.message}`);
  }

  // 2. Fan out each due send in keyset-paginated batches, then flip status.
  // Fanning out a large list in a single RPC exceeds the PostgREST/role
  // statement_timeout (~8s) and gets cancelled ("canceling statement due to
  // statement timeout"). fanout_..._batch does one ~5k-row slice per call —
  // each a separate, fast RPC — so no statement approaches the cap regardless
  // of list size. Idempotent: the keyset cursor advances by email, so a partial
  // run resumes cleanly on the next tick.
  const FANOUT_BATCH = Number(process.env.NEWSLETTER_FANOUT_BATCH ?? 5000);
  for (const send of (due ?? []) as DueSend[]) {
    try {
      let after: string | null = null;
      let guard = 0;
      for (;;) {
        const { data, error } = await supabase.rpc('fanout_newsletter_send_recipients_batch', {
          p_send_id: send.id,
          p_batch_size: FANOUT_BATCH,
          p_after_email: after,
        });
        if (error) throw new Error(error.message);
        const row = (Array.isArray(data) ? data[0] : data) as
          | { last_email: string | null; remaining: boolean }
          | null;
        if (!row) break;
        after = row.last_email ?? after;
        if (!row.remaining) break;
        // Backstop against a non-advancing cursor (shouldn't happen).
        if (++guard > 10_000) throw new Error('fanout batch guard tripped');
      }

      // Recompute the authoritative recipient count (idempotent-safe) and flip.
      const { count } = await supabase
        .from('newsletter_send_recipients')
        .select('*', { count: 'exact', head: true })
        .eq('send_id', send.id);

      const { error: flipErr } = await supabase
        .from('newsletter_sends')
        .update({
          status: 'sending',
          started_at: new Date().toISOString(),
          total_recipients: count ?? 0,
          updated_at: new Date().toISOString(),
        })
        .eq('id', send.id);
      if (flipErr) throw new Error(`flip to sending: ${flipErr.message}`);
      processed++;
    } catch (err) {
      const msg = `Send ${send.id}: ${(err as Error).message}`;
      console.error('[newsletter:dispatch-scheduled] fanout failed:', msg);
      errors.push(msg);
      // Mark the send failed so it doesn't get retried forever and operators
      // see something concrete in the UI.
      await supabase
        .from('newsletter_sends')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', send.id);
    }
  }

  if (processed) {
    console.log(`[newsletter:dispatch-scheduled] dispatched ${processed} due send(s)`);
  }
  if (errors.length) {
    console.error('[newsletter:dispatch-scheduled] send errors:', errors);
  }

  // 3. Per-recipient drip via the shared Central Sending Service engine. The
  // fanout above produced the rows; this picks up anything due (including
  // 'global' strategy sends whose send_at = now() per migration 054).
  let engine: { claimed: number; sent: number; failed: number } | null = null;
  try {
    const [engMod, bindMod] = await Promise.all([
      import('../../bulk-emailing/worker/send-engine/engine.js'),
      import('./send-engine-binding.js'),
    ]);
    // Interop-safe: these two modules have no package.json "type":"module",
    // so under tsx/CJS transpilation `await import()` nests their exports
    // under `.default` (named imports come back undefined). Resolve from
    // either shape so this works under tsx (worker) and true ESM (prod build).
    const runDripTick = (engMod as { runDripTick?: typeof import('../../bulk-emailing/worker/send-engine/engine.js').runDripTick }).runDripTick
      ?? (engMod as { default?: { runDripTick?: typeof import('../../bulk-emailing/worker/send-engine/engine.js').runDripTick } }).default?.runDripTick;
    const newsletterBinding = (bindMod as { newsletterBinding?: unknown }).newsletterBinding
      ?? (bindMod as { default?: { newsletterBinding?: unknown } }).default?.newsletterBinding;
    if (typeof runDripTick !== 'function' || !newsletterBinding) {
      throw new Error('send-engine modules did not expose runDripTick/newsletterBinding');
    }
    const logger = {
      info: (...a: unknown[]) => console.log('[send-engine]', ...a),
      warn: (...a: unknown[]) => console.warn('[send-engine]', ...a),
      error: (...a: unknown[]) => console.error('[send-engine]', ...a),
    };
    engine = await runDripTick(
      { supabase, logger, config: {
        claimBatch: Number(process.env.SEND_ENGINE_CLAIM_BATCH ?? 1000),
        batchSize: Number(process.env.SEND_ENGINE_BATCH_SIZE ?? 1000),
        budgetMs: Number(process.env.SEND_ENGINE_BUDGET_MS ?? 45000),
        dailyCap: Number(process.env.SEND_ENGINE_DAILY_CAP ?? Number.MAX_SAFE_INTEGER),
        rampPercent: Number(process.env.SEND_ENGINE_RAMP_PERCENT ?? 100),
        replica: process.env.HOSTNAME ?? 'worker',
      } },
      newsletterBinding as never,
    );
    if (engine.claimed) console.log(`[send-engine] newsletter drip: claimed ${engine.claimed}, sent ${engine.sent}, failed ${engine.failed}`);
  } catch (err) {
    console.error('[send-engine] newsletter worker drip failed:', err);
  }

  return { processed, errors, engine };
}
