// @ts-nocheck — supabase-js + bullmq resolved at module-host install time.

/**
 * event-speakers:promo-kit-sweep — cron heartbeat for speaker promo kits.
 *
 * Each tick:
 *   1. DISCOVER  — every confirmed talk of an upcoming event gets a
 *                  speaker_promo_kits row ('requested'), so kits generate
 *                  automatically once an admin confirms a talk (the portal
 *                  route also inserts rows on first open; both are idempotent
 *                  via the talk_id unique key).
 *   2. RETRY     — failed kits with attempts < 3 are re-armed.
 *   3. ADVANCE   — kits in 'requested'/'generating' get a generate-promo-kit
 *                  job (deduped via deterministic jobId). 'generating' kits
 *                  are re-enqueued to poll their text run until it settles.
 *
 * BullMQ is used directly because the runtime invokes worker handlers
 * without an enqueue helper (see the newsletters buzzword dispatch note).
 */

import { Queue } from 'bullmq';
import { serviceClient } from '../lib/promo/service-client.js';

const DISCOVER_CAP = 50;
const ENQUEUE_CAP = 10;
const MAX_KIT_ATTEMPTS = 3;

function jobsQueue(): Queue {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return new Queue('jobs', {
    prefix: `bull:${process.env.BRAND ?? 'default'}`,
    connection: {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password ? decodeURIComponent(url.password) : undefined,
      username: url.username ? decodeURIComponent(url.username) : undefined,
    },
  });
}

export default async function promoKitSweep(): Promise<void> {
  const supabase = serviceClient();
  const log = (m: string) => console.log(`[event-speakers] promo-kit-sweep: ${m}`);

  // ── 1. DISCOVER confirmed talks of upcoming events without a kit ───────
  const { data: talks, error: talksError } = await supabase
    .from('events_talks')
    .select('id, event_uuid, events!inner(id, event_start)')
    .eq('status', 'confirmed')
    .gte('events.event_start', new Date().toISOString())
    .limit(200);
  if (talksError) {
    log(`talk discovery failed: ${talksError.message}`);
  } else if (talks?.length) {
    const talkIds = talks.map((t) => t.id);
    const { data: existing } = await supabase
      .from('speaker_promo_kits')
      .select('talk_id')
      .in('talk_id', talkIds);
    const have = new Set((existing ?? []).map((k) => k.talk_id));
    const missing = talks.filter((t) => !have.has(t.id)).slice(0, DISCOVER_CAP);
    if (missing.length) {
      const { error: insError } = await supabase.from('speaker_promo_kits').upsert(
        missing.map((t) => ({ talk_id: t.id, event_uuid: t.event_uuid, status: 'requested' })),
        { onConflict: 'talk_id', ignoreDuplicates: true },
      );
      if (insError) log(`kit insert failed: ${insError.message}`);
      else log(`discovered ${missing.length} new confirmed talk(s)`);
    }
  }

  // ── 2. RETRY failed kits (bounded) ─────────────────────────────────────
  const { data: retriable } = await supabase
    .from('speaker_promo_kits')
    .select('id')
    .eq('status', 'failed')
    .lt('attempts', MAX_KIT_ATTEMPTS)
    .limit(ENQUEUE_CAP);
  if (retriable?.length) {
    await supabase
      .from('speaker_promo_kits')
      .update({ status: 'requested' })
      .in('id', retriable.map((k) => k.id));
    log(`re-armed ${retriable.length} failed kit(s)`);
  }

  // ── 3. ADVANCE pending kits ────────────────────────────────────────────
  const { data: pending } = await supabase
    .from('speaker_promo_kits')
    .select('id, status, attempts')
    .in('status', ['requested', 'generating'])
    .order('created_at', { ascending: true })
    .limit(ENQUEUE_CAP);
  if (!pending?.length) return;

  let queue: Queue | null = null;
  try {
    queue = jobsQueue();
    for (const kit of pending) {
      // Deterministic jobId dedupes against a still-queued job for the same
      // kit state; a new state/attempt gets a fresh id.
      await queue.add(
        'event-speakers:generate-promo-kit',
        { kitId: kit.id },
        { jobId: `es-promo-${kit.id}-${kit.status}-${kit.attempts ?? 0}`, removeOnComplete: 100, removeOnFail: 100 },
      );
    }
    log(`enqueued ${pending.length} generate job(s)`);
  } finally {
    if (queue) await queue.close().catch(() => {});
  }
}
