// @ts-nocheck — supabase-js resolved at module-host install time.

/**
 * Resolve everything the promo-kit pipeline needs for one talk: the talk,
 * its event, the primary speaker (bridge speaker_id is the CROSS-EVENT
 * profile id — see the events_talk_speakers FK comment in migration 001),
 * and the other confirmed speakers for cross-promotion.
 */

import type { PromoKitContext } from './types.js';

export async function loadPromoKitContext(supabase, talkId: string): Promise<PromoKitContext> {
  const { data: talk, error: talkError } = await supabase
    .from('events_talks')
    .select('id, event_uuid, title, synopsis, status, session_type, duration_minutes, edit_token')
    .eq('id', talkId)
    .maybeSingle();
  if (talkError || !talk) throw new Error(`talk not found: ${talkId}`);
  if (!talk.event_uuid) throw new Error('talk has no event (calendar/platform-scope talks have no promo kit)');

  const { data: event, error: eventError } = await supabase
    .from('events')
    .select(
      'id, event_id, event_slug, event_title, event_start, event_timezone, event_city, event_link, enable_native_registration',
    )
    .eq('id', talk.event_uuid)
    .maybeSingle();
  if (eventError || !event) throw new Error(`event not found for talk ${talkId}`);

  const { data: bridge } = await supabase
    .from('events_talk_speakers')
    .select('speaker_id')
    .eq('talk_id', talk.id)
    .eq('is_primary', true)
    .maybeSingle();
  if (!bridge?.speaker_id) throw new Error(`primary speaker not found for talk ${talkId}`);
  const profileId = bridge.speaker_id;

  // Per-event participation row with COALESCEd display fields.
  const { data: details } = await supabase
    .from('events_speakers_with_details')
    .select('full_name, job_title, company, avatar_url, speaker_bio')
    .eq('speaker_id', profileId)
    .eq('event_uuid', talk.event_uuid)
    .maybeSingle();

  const { data: profile } = await supabase
    .from('events_speaker_profiles')
    .select('name, title, company, bio, avatar_url')
    .eq('id', profileId)
    .maybeSingle();

  const fullName = details?.full_name || profile?.name || 'Speaker';

  // Other confirmed speakers at the same event, for cross-promotion.
  const { data: otherTalks } = await supabase
    .from('events_talks')
    .select('id, title')
    .eq('event_uuid', talk.event_uuid)
    .eq('status', 'confirmed')
    .neq('id', talk.id)
    .limit(25);
  const otherSpeakers: Array<{ name: string; talk_title: string }> = [];
  for (const other of otherTalks ?? []) {
    const { data: otherBridge } = await supabase
      .from('events_talk_speakers')
      .select('speaker_id')
      .eq('talk_id', other.id)
      .eq('is_primary', true)
      .maybeSingle();
    if (!otherBridge?.speaker_id) continue;
    const { data: otherProfile } = await supabase
      .from('events_speaker_profiles')
      .select('name')
      .eq('id', otherBridge.speaker_id)
      .maybeSingle();
    if (otherProfile?.name) otherSpeakers.push({ name: otherProfile.name, talk_title: other.title });
  }

  return {
    talk: {
      id: talk.id,
      title: talk.title,
      synopsis: talk.synopsis ?? null,
      status: talk.status,
      session_type: talk.session_type ?? null,
      duration_minutes: talk.duration_minutes ?? null,
      edit_token: talk.edit_token ?? null,
    },
    event,
    speaker: {
      profileId,
      fullName,
      jobTitle: details?.job_title || profile?.title || null,
      company: details?.company || profile?.company || null,
      bio: details?.speaker_bio || profile?.bio || null,
      avatarUrl: details?.avatar_url || profile?.avatar_url || null,
    },
    otherSpeakers,
  };
}

/** "SEPTEMBER 16" display style, in the event's timezone. */
export function dateShort(iso: string, timezone: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: timezone || 'UTC' })
      .format(new Date(iso))
      .toUpperCase();
  } catch {
    return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
      .format(new Date(iso))
      .toUpperCase();
  }
}
