// @ts-nocheck — depends on supabase-js; resolved at worker-host install time.

/**
 * plays:dispatch-send — the per-recipient drip for fan-out communication Plays
 * (spec-plays-scheduling-automation §4.2). A 60s heartbeat that (1) resyncs
 * send_at for any 'sending' countdown send whose anchor moved (§4.4), then
 * (2) runs the shared Central Sending Service engine over the plays binding.
 *
 * Co-located with the broadcast dispatcher because it imports the send-engine +
 * the (co-located) plays binding; registered as a broadcasts worker + cron so it
 * shares the same drip pool as newsletters/broadcasts.
 */

import { createClient } from '@supabase/supabase-js';

if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = class { addEventListener() {} removeEventListener() {} close() {} send() {} };
}

export default async function handler(job, ctx) {
  const supabase = (ctx && ctx.supabase) || createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const log = (m, x) => console.log(`[plays:dispatch-send] ${m}`, x ?? '');

  // 1. Anchor-drift resync: for each 'sending' countdown send whose anchor moved
  //    since fan-out, re-time its future pending rows (guarded RPC — pending only).
  try {
    const { data: sends } = await supabase
      .from('plays_sends').select('id, anchor_at, delivery').eq('status', 'sending').limit(200);
    for (const s of sends ?? []) {
      const mode = s.delivery && s.delivery.mode;
      if (mode !== 'countdown' || !s.anchor_at) continue;
      // (a full context-anchor re-resolution lives in the orchestrator; here we
      // only honour an anchor_at already advanced by a reschedule handler.)
      await supabase.rpc('resync_plays_send_at', { p_send_id: s.id });
    }
  } catch (e) { log('resync sweep failed', e && e.message); }

  // 2. Drip via the shared engine over the plays binding.
  let engine = null;
  try {
    const [engMod, bindMod] = await Promise.all([
      import('../../bulk-emailing/worker/send-engine/engine.js'),
      import('./plays-send-binding.js'),
    ]);
    const runDripTick = engMod.runDripTick ?? engMod.default?.runDripTick;
    const playsBinding = bindMod.playsBinding ?? bindMod.default?.playsBinding;
    if (typeof runDripTick !== 'function' || !playsBinding) {
      throw new Error('send-engine modules did not expose runDripTick/playsBinding');
    }
    const logger = {
      info: (...a) => console.log('[send-engine]', ...a),
      warn: (...a) => console.warn('[send-engine]', ...a),
      error: (...a) => console.error('[send-engine]', ...a),
    };
    engine = await runDripTick({
      supabase, logger, config: {
        claimBatch: Number(process.env.SEND_ENGINE_CLAIM_BATCH ?? 1000),
        batchSize: Number(process.env.SEND_ENGINE_BATCH_SIZE ?? 1000),
        budgetMs: Number(process.env.SEND_ENGINE_BUDGET_MS ?? 45000),
        dailyCap: Number(process.env.SEND_ENGINE_DAILY_CAP ?? Number.MAX_SAFE_INTEGER),
        rampPercent: Number(process.env.SEND_ENGINE_RAMP_PERCENT ?? 100),
        replica: process.env.HOSTNAME ?? 'worker',
      },
    }, playsBinding);
    if (engine.claimed) log('drip', engine);
  } catch (err) {
    console.error('[plays:dispatch-send] drip failed:', err);
  }
  return { engine };
}
