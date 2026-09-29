/**
 * Data layer for the event media organizer.
 *
 * Media, albums and ordering go through the host-media admin API
 * (authorized per event server-side). Sponsor tags are event-specific
 * and live in events_media_sponsor_tags; they are read and written with
 * the admin's own Supabase session, so the table's RLS (can_admin_event)
 * is the gate.
 */

import { supabase } from '@/lib/supabase';
import {
  listAllHostMedia,
  listAlbums,
  listAlbumItems,
  errorMessage,
} from '@gatewaze-modules/host-media/admin';
import type { HostMediaItem, HostMediaAlbum, HostMediaAlbumItem } from '@gatewaze-modules/host-media/client-types';

export type { HostMediaItem, HostMediaAlbum, HostMediaAlbumItem };

export const HOST_KIND = 'event';

export {
  type MediaKind,
  mediaKind,
  guestName,
  uploaderKey,
  boothLightReport,
  takenKey,
  takenAtLabel,
  compareTaken,
  isGuestUpload,
  formatFileSize,
  formatDuration,
  mergeSubsetOrder,
} from '../../lib/organizer';

export interface EventSponsorOption {
  /** events_sponsors.id — what a tag points at. */
  id: string;
  name: string;
  logoUrl: string | null;
  tier: string | null;
  boothNumber: string | null;
}

export interface MediaSponsorTag {
  id: string;
  media_id: string;
  event_sponsor_id: string;
}

export async function loadOrganizerMedia(eventId: string): Promise<HostMediaItem[]> {
  return listAllHostMedia(HOST_KIND, eventId);
}

export async function loadAlbums(eventId: string): Promise<HostMediaAlbum[]> {
  const resp = await listAlbums(HOST_KIND, eventId);
  if (!resp.ok) throw new Error(await errorMessage(resp, 'Failed to load albums'));
  const body = (await resp.json()) as { albums: HostMediaAlbum[] };
  return body.albums ?? [];
}

/**
 * Which of this event's albums are hidden from the portal's album view
 * (migration 016). An album with no row is shown, so this returns only
 * the ones taken off it.
 *
 * Read and written straight from the browser under RLS, as the sponsor
 * tags are: the policy is can_admin_host_media('event', …).
 */
export interface AlbumSetting {
  /** Shown in the portal's album view. Absent row = shown. */
  show_on_portal: boolean;
  /** Portal shows the enhanced copy of each photograph that has one. */
  enhance: boolean;
  /** Portal may show the selfies behind this album's booth pictures. */
  xray: boolean;
  /**
   * Which improved copy to show where `enhance` is on: the arithmetic
   * one, or the model's. Both are kept; this only chooses.
   */
  enhance_source: 'standard' | 'ai';
  /**
   * The shape this album's improved copies are delivered in: as the
   * phone gave it, cropped to 3:2/2:3, or expanded to it by a model.
   */
  frame: 'as-shot' | 'classic' | 'expand';
}

export async function loadAlbumSettings(eventId: string): Promise<Map<string, AlbumSetting>> {
  const { data, error } = await supabase
    .from('event_media_album_settings')
    .select('album_id, show_on_portal, enhance, xray, enhance_source, frame')
    .eq('event_id', eventId);
  // A settings table that cannot be read must not fail the whole tab;
  // every album simply reads as its default, which is what it was.
  if (error) return new Map();
  return new Map((data ?? []).map((r: {
    album_id: string; show_on_portal: boolean; enhance: boolean; xray: boolean;
    enhance_source?: string | null; frame?: string | null;
  }) => (
    [r.album_id, {
      show_on_portal: r.show_on_portal !== false,
      enhance: r.enhance === true,
      xray: r.xray === true,
      enhance_source: r.enhance_source === 'ai' ? 'ai' as const : 'standard' as const,
      frame: r.frame === 'classic' ? 'classic' as const
        : r.frame === 'expand' ? 'expand' as const : 'as-shot' as const,
    }]
  )));
}

export async function saveAlbumSetting(
  eventId: string,
  albumId: string,
  patch: Partial<AlbumSetting>,
  current: AlbumSetting,
): Promise<void> {
  const { error } = await supabase
    .from('event_media_album_settings')
    .upsert(
      {
        album_id: albumId,
        event_id: eventId,
        show_on_portal: patch.show_on_portal ?? current.show_on_portal,
        enhance: patch.enhance ?? current.enhance,
        xray: patch.xray ?? current.xray,
        enhance_source: patch.enhance_source ?? current.enhance_source,
        frame: patch.frame ?? current.frame,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'album_id' },
    );
  if (error) throw new Error(error.message);
}

export async function loadAlbumItems(eventId: string): Promise<HostMediaAlbumItem[]> {
  const resp = await listAlbumItems(HOST_KIND, eventId);
  if (!resp.ok) throw new Error(await errorMessage(resp, 'Failed to load album items'));
  const body = (await resp.json()) as { items: HostMediaAlbumItem[] };
  return body.items ?? [];
}

interface SponsorRow {
  id: string;
  sponsor_name: string | null;
  sponsor_logo_url: string | null;
  sponsorship_tier: string | null;
  tier: string | null;
  booth_number: string | null;
  sponsor: { name: string | null; logo_url: string | null } | null;
}

/**
 * Active sponsors of the event. Returns [] when the event-sponsors
 * tables are unavailable rather than failing the whole tab.
 */
export async function loadEventSponsors(eventId: string): Promise<EventSponsorOption[]> {
  const { data, error } = await supabase
    .from('events_sponsors')
    .select('id, sponsor_name, sponsor_logo_url, sponsorship_tier, tier, booth_number, sponsor:events_sponsor_profiles!sponsor_id(name, logo_url)')
    .eq('event_id', eventId)
    .eq('is_active', true);
  if (error) {
    console.warn('[event-media] sponsors unavailable:', error.message);
    return [];
  }
  return ((data ?? []) as unknown as SponsorRow[])
    .map((r) => ({
      id: r.id,
      name: r.sponsor?.name || r.sponsor_name || 'Unknown sponsor',
      logoUrl: r.sponsor?.logo_url || r.sponsor_logo_url || null,
      tier: r.sponsorship_tier || r.tier || null,
      boothNumber: r.booth_number,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every sponsor tag on this event's media (RLS scopes it to the event's admins). */
export async function loadSponsorTags(sponsorIds: string[]): Promise<MediaSponsorTag[]> {
  if (sponsorIds.length === 0) return [];
  const { data, error } = await supabase
    .from('events_media_sponsor_tags')
    .select('id, media_id, event_sponsor_id')
    .in('event_sponsor_id', sponsorIds);
  if (error) {
    console.warn('[event-media] sponsor tags unavailable:', error.message);
    return [];
  }
  return (data ?? []) as MediaSponsorTag[];
}

/** Tags every media id with every sponsor id; existing pairs are left alone. */
export async function tagMediaWithSponsors(mediaIds: string[], sponsorIds: string[]): Promise<void> {
  const rows = mediaIds.flatMap((media_id) => sponsorIds.map((event_sponsor_id) => ({ media_id, event_sponsor_id })));
  if (rows.length === 0) return;
  const { error } = await supabase
    .from('events_media_sponsor_tags')
    .upsert(rows, { onConflict: 'media_id,event_sponsor_id', ignoreDuplicates: true });
  if (error) throw new Error(error.message);
}

export async function untagMediaSponsor(mediaId: string, sponsorId: string): Promise<void> {
  const { error } = await supabase
    .from('events_media_sponsor_tags')
    .delete()
    .eq('media_id', mediaId)
    .eq('event_sponsor_id', sponsorId);
  if (error) throw new Error(error.message);
}

