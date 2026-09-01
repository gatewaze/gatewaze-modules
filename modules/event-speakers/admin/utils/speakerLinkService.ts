/**
 * Speaker Link Service — READ-ONLY stats for speaker tracking links.
 *
 * Links themselves are minted by the promo-kit worker (umami provider,
 * modules/event-speakers/lib/promo/tracking-link.ts) when a talk is
 * confirmed; the old admin-side Short.io creation path is gone. This
 * service reads the `redirects` rows (source_type='speaker') and joins:
 *   - clicks: umami links via GET /api/redirects/link/:id/stats (the
 *     legacy short.io columns stay as a fallback for pre-migration rows);
 *   - registrations: events_registrations by the utm_campaign=<speaker
 *     profile id> attribution triple, which is provider-independent.
 */

import { getApiBaseUrl } from '@/config/brands';
import { supabase } from '@/lib/supabase';

export interface SpeakerTrackingLink {
  speakerId: string;
  shortUrl: string;
  originalUrl: string;
  path: string;
  totalClicks: number;
  humanClicks: number;
  uniqueClicks: number;
  registrationCount: number;
  /** Scans of the LinkedIn QR code on this speaker's slide deck. */
  qrScans: number;
  redirectId: string | null;
}

/** getApiBaseUrl() returns a base that ALREADY ends in /api (e.g.
 *  `${VITE_API_URL}/api`, or bare '/api' behind the dev proxy) — appending
 *  an /api-prefixed path doubles it into /api/api/... 404s. Join tolerantly
 *  so either base shape works. */
function apiUrl(path: string): string {
  const base = getApiBaseUrl().replace(/\/+$/, '');
  return base.endsWith('/api') ? `${base}${path.replace(/^\/api/, '')}` : `${base}${path}`;
}

/** 90-day click counts for umami-provider redirects, keyed by redirect id.
 *  Failures degrade to an empty map — the badge then shows the stored
 *  (possibly zero) counts rather than blocking the tab. */
async function getUmamiClicks(redirectIds: string[]): Promise<Record<string, { clicks: number; unique: number }>> {
  if (redirectIds.length === 0) return {};
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) return {};
  const entries = await Promise.all(
    redirectIds.map(async (id) => {
      try {
        const res = await fetch(apiUrl(`/api/redirects/link/${encodeURIComponent(id)}/stats`), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { clicks?: number; unique_visitors?: number };
        return [id, { clicks: body.clicks ?? 0, unique: body.unique_visitors ?? 0 }] as const;
      } catch {
        return null;
      }
    }),
  );
  return Object.fromEntries(entries.filter((e): e is NonNullable<typeof e> => e !== null));
}

/**
 * Get all speaker tracking links for an event, with click + registration
 * stats. Queries the redirects table for links with source_type='speaker'.
 */
export async function getSpeakerLinksForEvent(
  eventId: string,
  speakerIds: string[]
): Promise<Record<string, SpeakerTrackingLink>> {
  if (speakerIds.length === 0) {
    return {};
  }

  // Two redirect kinds per speaker: 'speaker' is their share link, and
  // 'speaker_linkedin' is the QR code on their slide deck. They are separate
  // rows so the click and scan counts stay apart.
  const { data: allRedirects, error } = await supabase
    .from('redirects')
    .select('id, short_url, original_url, path, total_clicks, human_clicks, unique_clicks, source_id, provider, source_type')
    .in('source_type', ['speaker', 'speaker_linkedin'])
    .in('source_id', speakerIds);
  const redirects = (allRedirects ?? []).filter((r) => r.source_type === 'speaker');
  const qrRedirects = (allRedirects ?? []).filter((r) => r.source_type === 'speaker_linkedin');

  if (error || !allRedirects) {
    // Silently handle missing redirects table (module not installed)
    if (error?.code === 'PGRST204' || error?.code === 'PGRST205' || error?.message?.includes('schema cache')) {
      return {};
    }
    console.error('Error fetching speaker links:', error);
    return {};
  }

  // Umami links carry no synced click columns — fetch live counts.
  const umamiIds = [...redirects, ...qrRedirects].filter((r) => r.provider === 'umami').map((r) => r.id);
  const [umamiClicks, registrationCounts] = await Promise.all([
    getUmamiClicks(umamiIds),
    getSpeakerRegistrationCounts(eventId, speakerIds),
  ]);
  // Scans of the deck's LinkedIn QR, keyed by speaker.
  const qrScansBySpeaker: Record<string, number> = {};
  for (const r of qrRedirects) {
    qrScansBySpeaker[r.source_id] = umamiClicks[r.id]?.clicks ?? r.human_clicks ?? r.total_clicks ?? 0;
  }

  const result: Record<string, SpeakerTrackingLink> = {};
  for (const redirect of redirects) {
    const speakerId = redirect.source_id;
    const live = umamiClicks[redirect.id];
    result[speakerId] = {
      speakerId,
      shortUrl: redirect.short_url,
      originalUrl: redirect.original_url,
      path: redirect.path,
      totalClicks: live?.clicks ?? redirect.total_clicks ?? 0,
      humanClicks: live?.clicks ?? redirect.human_clicks ?? 0,
      uniqueClicks: live?.unique ?? redirect.unique_clicks ?? 0,
      registrationCount: registrationCounts[speakerId] || 0,
      qrScans: qrScansBySpeaker[speakerId] || 0,
      redirectId: redirect.id,
    };
  }

  return result;
}

/**
 * Get the count of registrations attributed to a specific speaker
 * via UTM campaign tracking
 */
export async function getSpeakerRegistrationCount(
  eventId: string,
  speakerId: string
): Promise<number> {
  const { count, error } = await supabase
    .from('events_registrations')
    .select('*', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .eq('utm_source', 'speaker')
    .eq('utm_campaign', speakerId);

  if (error) {
    console.error('Error counting speaker registrations:', error);
    return 0;
  }

  return count || 0;
}

/**
 * Get registration counts for multiple speakers in one query
 */
async function getSpeakerRegistrationCounts(
  eventId: string,
  speakerIds: string[]
): Promise<Record<string, number>> {
  if (speakerIds.length === 0) {
    return {};
  }

  const { data: registrations, error } = await supabase
    .from('events_registrations')
    .select('utm_campaign')
    .eq('event_id', eventId)
    .eq('utm_source', 'speaker')
    .in('utm_campaign', speakerIds);

  if (error || !registrations) {
    console.error('Error fetching speaker registration counts:', error);
    return {};
  }

  const counts: Record<string, number> = {};
  for (const reg of registrations) {
    const speakerId = reg.utm_campaign;
    if (speakerId) {
      counts[speakerId] = (counts[speakerId] || 0) + 1;
    }
  }

  return counts;
}

export const SpeakerLinkService = {
  getSpeakerLinksForEvent,
  getSpeakerRegistrationCount,
};

export default SpeakerLinkService;
