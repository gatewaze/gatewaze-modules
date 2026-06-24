import type { Job } from 'bullmq';
// Static import (a bare-specifier dynamic import does not resolve from this
// module-file location in the worker runtime — see newsletters/broadcasts).
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface DispatchJobData { kind: string }

/**
 * Central Sending Service bulk drip (Phase 3). Unlike newsletters/broadcasts,
 * bulk has no scheduled→sending fanout owned by an Edge function — a bulk job is
 * fanned out into bulk_send_recipients by its producer — so this 60s heartbeat
 * just drives the shared worker engine over due bulk recipients. Always active;
 * only claims recipients that have been fanned out into the queue.
 */
export default async function handleBulkDrip(_job: Job<DispatchJobData>) {
  try {
    // Destructure all three imports — previously this dropped the third
    // result and the later `evtBindMod` reference threw ReferenceError on
    // every drip tick, leaving Phase-3 sends stranded at whatever the first
    // pre-engine batch had already shipped (1750 of 55546 on 2026-06-24).
    const [engMod, bindMod, evtBindMod] = await Promise.all([
      import('../worker/send-engine/engine.js'),
      import('./send-engine-binding.js'),
      import('./send-engine-binding-events.js'),
    ]);
    // Interop-safe: these modules have no package.json "type":"module", so under
    // tsx/CJS `await import()` nests exports under .default.
    const runDripTick = (engMod as { runDripTick?: typeof import('../worker/send-engine/engine.js').runDripTick }).runDripTick
      ?? (engMod as { default?: { runDripTick?: typeof import('../worker/send-engine/engine.js').runDripTick } }).default?.runDripTick;
    const bulkBinding = (bindMod as { bulkBinding?: unknown }).bulkBinding
      ?? (bindMod as { default?: { bulkBinding?: unknown } }).default?.bulkBinding;
    const eventCommsBinding = (evtBindMod as { eventCommsBinding?: unknown }).eventCommsBinding
      ?? (evtBindMod as { default?: { eventCommsBinding?: unknown } }).default?.eventCommsBinding;
    if (typeof runDripTick !== 'function' || !bulkBinding || !eventCommsBinding) {
      throw new Error('send-engine modules did not expose runDripTick/bulkBinding/eventCommsBinding');
    }
    const supabase = createClient(supabaseUrl, supabaseServiceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const logger = {
      info: (...a: unknown[]) => console.log('[send-engine]', ...a),
      warn: (...a: unknown[]) => console.warn('[send-engine]', ...a),
      error: (...a: unknown[]) => console.error('[send-engine]', ...a),
    };
    const deps = { supabase, logger, config: {
      claimBatch: Number(process.env.SEND_ENGINE_CLAIM_BATCH ?? 1000),
      batchSize: Number(process.env.SEND_ENGINE_BATCH_SIZE ?? 1000),
      budgetMs: Number(process.env.SEND_ENGINE_BUDGET_MS ?? 45000),
      dailyCap: Number(process.env.SEND_ENGINE_DAILY_CAP ?? Number.MAX_SAFE_INTEGER),
      rampPercent: Number(process.env.SEND_ENGINE_RAMP_PERCENT ?? 100),
      replica: process.env.HOSTNAME ?? 'worker',
    } };
    // One tick drives every queue-backed domain: bulk + event comms. Each binding
    // claims only its own due recipients, so running them in sequence is safe.
    const engine = await runDripTick(deps, bulkBinding as never);
    if (engine.claimed) console.log(`[send-engine] bulk drip: claimed ${engine.claimed}, sent ${engine.sent}, failed ${engine.failed}`);
    const events = await runDripTick(deps, eventCommsBinding as never);
    if (events.claimed) console.log(`[send-engine] event-comms drip: claimed ${events.claimed}, sent ${events.sent}, failed ${events.failed}`);
    return { engine, events };
  } catch (err) {
    console.error('[send-engine] bulk worker drip failed:', err);
    return { error: (err as Error).message };
  }
}
