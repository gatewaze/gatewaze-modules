// @ts-nocheck — supabase-js + bullmq resolved at module-host install time.

/**
 * event-speakers:promo-kit-sweep — cron heartbeat for speaker speaker kits.
 *
 * Each tick:
 *   1. DISCOVER  — every ELIGIBLE confirmed talk gets a speaker_promo_kits
 *                  row ('requested'), so kits generate automatically once an
 *                  admin confirms a talk (the portal route also inserts rows
 *                  on first open; both are idempotent via the talk_id unique
 *                  key). Eligibility is lib/promo/eligibility.ts: the event
 *                  must not have finished or be more than a year out, and the
 *                  speaker must have an avatar. See that file for the
 *                  incident that put the avatar rule there.
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
import {
  partitionEligible,
  describeSkipped,
  DEFAULT_HORIZON_DAYS,
  type EligibilityInput,
} from '../lib/promo/eligibility.js';

const DISCOVER_CAP = 50;
/** PostgREST `in.(...)` rides in the query string, so chunk the lookups. */
const IN_CHUNK = 200;
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

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run one `.in()` select over chunked ids, returning [] on failure. */
async function selectIn(supabase, table: string, columns: string, column: string, ids: string[], log) {
  const rows: Array<Record<string, unknown>> = [];
  for (const chunk of chunks(ids, IN_CHUNK)) {
    const res = await supabase.from(table).select(columns).in(column, chunk);
    if (res.error) {
      log(`${table} lookup failed: ${res.error.message}`);
      return [];
    }
    rows.push(...(res.data ?? []));
  }
  return rows;
}

/**
 * talk id → the primary speaker's avatar URL, or null.
 *
 * Mirrors lib/promo/context.ts: the bridge row's `speaker_id` is the
 * CROSS-EVENT profile id, the per-event `events_speakers_with_details` row
 * wins over the profile, and either may be empty.
 *
 * A lookup failure yields null for the affected talks, which the gate treats
 * as "no avatar" and therefore skips. That is the right way round: a transient
 * read error should delay a kit, never mint one with an empty photo frame.
 */
async function loadPrimarySpeakerAvatars(
  supabase,
  talks: Array<{ id: string; event_uuid: string }>,
  log: (m: string) => void,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const t of talks) out.set(t.id, null);

  const bridges = await selectIn(
    supabase, 'events_talk_speakers', 'talk_id, speaker_id, is_primary', 'talk_id',
    talks.map((t) => t.id), log,
  );
  const profileByTalk = new Map<string, string>();
  for (const b of bridges) {
    if (b.is_primary !== true) continue;
    if (b.talk_id && b.speaker_id) profileByTalk.set(String(b.talk_id), String(b.speaker_id));
  }
  if (profileByTalk.size === 0) return out;

  const profileIds = [...new Set(profileByTalk.values())];
  const profiles = await selectIn(
    supabase, 'events_speaker_profiles', 'id, avatar_url', 'id', profileIds, log,
  );
  const profileAvatar = new Map<string, string | null>(
    profiles.map((p) => [String(p.id), (p.avatar_url as string | null) ?? null]),
  );

  // The per-event row, keyed (speaker_id, event_uuid) like context.ts.
  const details = await selectIn(
    supabase, 'events_speakers_with_details', 'speaker_id, event_uuid, avatar_url',
    'speaker_id', profileIds, log,
  );
  const eventUuids = new Set(talks.map((t) => t.event_uuid));
  const detailAvatar = new Map<string, string | null>();
  for (const d of details) {
    if (!eventUuids.has(String(d.event_uuid))) continue;
    detailAvatar.set(`${d.speaker_id}|${d.event_uuid}`, (d.avatar_url as string | null) ?? null);
  }

  for (const t of talks) {
    const profileId = profileByTalk.get(t.id);
    if (!profileId) continue;
    const perEvent = detailAvatar.get(`${profileId}|${t.event_uuid}`);
    out.set(t.id, perEvent || profileAvatar.get(profileId) || null);
  }
  return out;
}

export default async function promoKitSweep(): Promise<void> {
  const supabase = serviceClient();
  const log = (m: string) => console.log(`[event-speakers] promo-kit-sweep: ${m}`);

  // ── 1. DISCOVER confirmed talks eligible for a kit ─────────────────────
  //
  // The date filter here is deliberately loose: it only drops events that
  // ended well in the past, so the page size is not wasted on history. The
  // real decision is lib/promo/eligibility.ts, which also needs the END date
  // and the speaker's avatar, neither of which this query can express.
  const floor = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: talks, error: talksError } = await supabase
    .from('events_talks')
    .select('id, event_uuid, events!inner(id, event_start, event_end)')
    .eq('status', 'confirmed')
    .gte('events.event_start', floor)
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
    const candidates = talks.filter((t) => !have.has(t.id));

    // Resolve each candidate's avatar the SAME way lib/promo/context.ts does,
    // so the gate and the card renderer can never disagree: the primary
    // speaker's per-event row first, then the cross-event profile. Batched,
    // because discovery looks at up to 200 talks and context.ts is per-talk.
    const avatarByTalk = candidates.length
      ? await loadPrimarySpeakerAvatars(supabase, candidates, log)
      : new Map<string, string | null>();

    const inputs: EligibilityInput[] = candidates.map((t) => ({
      talkId: t.id,
      eventStart: t.events?.event_start ?? null,
      eventEnd: t.events?.event_end ?? null,
      avatarUrl: avatarByTalk.get(t.id) ?? null,
    }));
    const horizonDays = Number(process.env.PROMO_KIT_HORIZON_DAYS ?? DEFAULT_HORIZON_DAYS);
    const { eligible, skipped } = partitionEligible(inputs, { horizonDays });

    const byId = new Map(candidates.map((t) => [t.id, t]));
    const missing = eligible.slice(0, DISCOVER_CAP);
    if (missing.length) {
      const { error: insError } = await supabase.from('speaker_promo_kits').upsert(
        missing.map((e) => ({
          talk_id: e.talkId,
          event_uuid: byId.get(e.talkId)?.event_uuid,
          status: 'requested',
        })),
        { onConflict: 'talk_id', ignoreDuplicates: true },
      );
      if (insError) log(`kit insert failed: ${insError.message}`);
      else log(`discovered ${missing.length} eligible talk(s)`);
    }
    if (candidates.length !== eligible.length) {
      log(`skipped ${candidates.length - eligible.length} talk(s): ${describeSkipped(skipped)}`);
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
    .select('id, status, attempts, updated_at')
    .in('status', ['requested', 'generating'])
    .order('created_at', { ascending: true })
    .limit(ENQUEUE_CAP);
  if (!pending?.length) return;

  let queue: Queue | null = null;
  try {
    queue = jobsQueue();
    for (const kit of pending) {
      // jobId dedupes concurrent sweeps enqueuing the same kit state, keyed
      // on updated_at: every state transition (including a manual reset to
      // 'requested') mints a fresh id. Keying on status/attempts collided
      // with BullMQ's retained completed-job ids after a reset, silently
      // dropping the re-enqueue.
      const stamp = Date.parse(kit.updated_at ?? '') || 0;
      await queue.add(
        'event-speakers:generate-promo-kit',
        { kitId: kit.id },
        { jobId: `es-promo-${kit.id}-${stamp}`, removeOnComplete: 100, removeOnFail: 100 },
      );
    }
    log(`enqueued ${pending.length} generate job(s)`);
  } finally {
    if (queue) await queue.close().catch(() => {});
  }
}
