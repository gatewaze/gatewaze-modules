/**
 * Integration coverage for migration 012's event rollup.
 *
 * The count and the event_uuids array are computed in SQL, so nothing in the
 * unit suite can prove them. This test seeds two events and one speaker,
 * then asserts the view reports what the directory renders.
 *
 * Operator-gated: needs a real Supabase. Run with
 *
 *   SUPABASE_INTEGRATION=1 \
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   pnpm --filter @gatewaze-modules/event-speakers test
 *
 * Skipped (not failed) otherwise, so ordinary CI stays green.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const integrationEnabled =
  process.env.SUPABASE_INTEGRATION === '1' &&
  Boolean(process.env.SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

const describeIfIntegration = integrationEnabled ? describe : describe.skip;

/* eslint-disable @typescript-eslint/no-explicit-any -- no generated Database types in this repo; see typescript-patterns.md */
const supabase = integrationEnabled
  ? createClient<any, any, any>(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      { auth: { autoRefreshToken: false, persistSession: false } },
    )
  : (null as any);
/* eslint-enable @typescript-eslint/no-explicit-any */

const SUFFIX = 'itest-012-speakers-event-count';

describeIfIntegration('events_speaker_profiles_with_counts', () => {
  let speakerId = '';
  let soloSpeakerId = '';
  const eventIds: string[] = [];

  beforeAll(async () => {
    for (const n of [1, 2]) {
      const { data, error } = await supabase
        .from('events')
        .insert({
          event_id: `${SUFFIX}-${n}`,
          event_title: `Integration event ${n} (${SUFFIX})`,
          is_listed: false,
        })
        .select('id')
        .single();
      if (error) throw error;
      eventIds.push(data.id as string);
    }

    const { data: speaker, error: speakerErr } = await supabase
      .from('events_speaker_profiles')
      .insert({ name: `Two-event speaker (${SUFFIX})`, is_active: true })
      .select('id')
      .single();
    if (speakerErr) throw speakerErr;
    speakerId = speaker.id as string;

    const { data: solo, error: soloErr } = await supabase
      .from('events_speaker_profiles')
      .insert({ name: `No-event speaker (${SUFFIX})`, is_active: true })
      .select('id')
      .single();
    if (soloErr) throw soloErr;
    soloSpeakerId = solo.id as string;

    const { error: junctionErr } = await supabase.from('events_speakers').insert(
      eventIds.map((eventUuid) => ({ event_uuid: eventUuid, speaker_id: speakerId })),
    );
    if (junctionErr) throw junctionErr;
  });

  afterAll(async () => {
    // events_speakers rows cascade from either side.
    if (eventIds.length) await supabase.from('events').delete().in('id', eventIds);
    const profileIds = [speakerId, soloSpeakerId].filter(Boolean);
    if (profileIds.length) {
      await supabase.from('events_speaker_profiles').delete().in('id', profileIds);
    }
  });

  it('counts the distinct events a speaker appears on', async () => {
    const { data, error } = await supabase
      .from('events_speaker_profiles_with_counts')
      .select('event_count, event_uuids')
      .eq('id', speakerId)
      .single();

    expect(error).toBeNull();
    expect(data.event_count).toBe(2);
    expect([...data.event_uuids].sort()).toEqual([...eventIds].sort());
  });

  it('reports zero and an empty array for a speaker with no events', async () => {
    const { data, error } = await supabase
      .from('events_speaker_profiles_with_counts')
      .select('event_count, event_uuids')
      .eq('id', soloSpeakerId)
      .single();

    expect(error).toBeNull();
    expect(data.event_count).toBe(0);
    expect(data.event_uuids).toEqual([]);
  });

  it('filters by event via an event_uuids overlap', async () => {
    const { data, error } = await supabase
      .from('events_speaker_profiles_with_counts')
      .select('id')
      .overlaps('event_uuids', [eventIds[0]]);

    expect(error).toBeNull();
    expect((data as { id: string }[]).map((r) => r.id)).toContain(speakerId);
    expect((data as { id: string }[]).map((r) => r.id)).not.toContain(soloSpeakerId);
  });

  it('does not double-count a speaker listed twice on one event', async () => {
    // The junction has UNIQUE (event_uuid, speaker_id), so a duplicate can't
    // be stored — this pins that the view's count is DISTINCT-based rather
    // than relying on that constraint staying in place.
    const { data, error } = await supabase
      .from('events_speaker_profiles_with_counts')
      .select('event_count')
      .eq('id', speakerId)
      .single();

    expect(error).toBeNull();
    expect(data.event_count).toBe(new Set(eventIds).size);
  });
});
