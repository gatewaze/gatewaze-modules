/**
 * Pure helpers for the event media organizer (no browser or Supabase
 * imports, so they are unit-tested and typechecked with the module).
 */

/** The row fields these helpers read; host_media rows satisfy it. */
export interface MediaLike {
  mime_type: string;
  metadata: Record<string, unknown> | null;
}

export type MediaKind = 'photo' | 'video' | 'audio' | 'other';

export function mediaKind(item: Pick<MediaLike, 'mime_type'>): MediaKind {
  if (item.mime_type.startsWith('image/')) return 'photo';
  if (item.mime_type.startsWith('video/')) return 'video';
  if (item.mime_type.startsWith('audio/')) return 'audio';
  return 'other';
}

/** Guest name for rows uploaded through a guest QR link, else null. */
export function guestName(item: Pick<MediaLike, 'metadata'>): string | null {
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  return meta['source'] === 'guest' && typeof meta['guest_name'] === 'string' && meta['guest_name']
    ? (meta['guest_name'] as string)
    : null;
}

export function isGuestUpload(item: Pick<MediaLike, 'metadata'>): boolean {
  return ((item.metadata ?? {}) as Record<string, unknown>)['source'] === 'guest';
}

export function formatFileSize(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Merges a reordered subset back into the full ordering: the subset's
 * members keep the slots they occupied in `fullIds`, filled in their new
 * order. Lets the admin drag within a filtered view (photos only, one
 * sponsor…) without scrambling the positions of the hidden items.
 */
export function mergeSubsetOrder(fullIds: string[], reorderedSubset: string[]): string[] {
  const subset = new Set(reorderedSubset);
  let next = 0;
  return fullIds.map((id) => (subset.has(id) ? reorderedSubset[next++]! : id));
}
