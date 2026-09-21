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

