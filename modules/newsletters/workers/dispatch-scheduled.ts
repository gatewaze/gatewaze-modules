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

/**
 * Heartbeat that fires due scheduled newsletter sends.
 *
 * Scheduling is DB-as-source-of-truth: a scheduled send is just a
 * `newsletter_sends` row with `status='scheduled'` and a `scheduled_at`.
 * This cron worker runs every 60s and asks the `newsletter-send` edge
 * function to process any rows that have come due
 * (`{ process_scheduled: true }`) — exactly the call pg_cron would have
 * made, but driven by BullMQ/Redis so it works on every deploy target
 * (Docker, k8s, cloud + self-hosted Supabase) without relying on the
 * pg_cron / pg_net extensions being installed.
 *
 * The edge function owns the actual send logic (single implementation):
 * it selects `status='scheduled' AND scheduled_at <= now()`, flips each
 * to 'sending', and dispatches. Overlapping ticks are safe — the status
 * flip plus the `FOR UPDATE SKIP LOCKED` recipient claim guard against
 * double-sends, so this worker only needs to be a dumb trigger.
 */
export default async function handleDispatchScheduled(_job: Job<DispatchJobData>) {
  const res = await fetch(`${supabaseUrl}/functions/v1/newsletter-send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${supabaseServiceKey}`,
      apikey: supabaseServiceKey,
    },
    body: JSON.stringify({ process_scheduled: true }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // Throw so BullMQ records the failure and retries on the next tick.
    throw new Error(`newsletter-send process_scheduled failed (${res.status}): ${detail}`);
  }

  const result = (await res.json().catch(() => ({}))) as {
    processed?: number;
    errors?: string[];
  };
  if (result.errors && result.errors.length > 0) {
    console.error('[newsletter:dispatch-scheduled] send errors:', result.errors);
  }
  if (result.processed) {
    console.log(`[newsletter:dispatch-scheduled] dispatched ${result.processed} due send(s)`);
  }

  // Central Sending Service canary: when SEND_ENGINE_USE_WORKER=true, the Edge
  // call above did fanout + global sends but SKIPPED its per-recipient drip
  // (see newsletter-send). The Node worker now owns that drip via the shared
  // high-throughput engine. Flag off → this block is skipped and the Edge path
  // dripped as before (behaviour unchanged).
  let engine: { claimed: number; sent: number; failed: number } | null = null;
  if (process.env.SEND_ENGINE_USE_WORKER === 'true') {
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
      const supabase = createClient(supabaseUrl, supabaseServiceKey, { auth: { autoRefreshToken: false, persistSession: false } });
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
  }

  return { processed: result.processed ?? 0, errors: result.errors ?? [], engine };
}
