/**
 * Pure helpers for the event media organizer (no browser or Supabase
 * imports, so they are unit-tested and typechecked with the module).
 */

/** The row fields these helpers read; host_media rows satisfy it. */
export interface MediaLike {
  mime_type: string;
  metadata: Record<string, unknown> | null;
}

/** EXIF capture time as the portal records it: local, no zone. */
const TAKEN_AT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/;

/**
 * When a photograph was taken, as something to sort on.
 *
 * The EXIF capture time where the photograph carries one, the moment it
 * was uploaded otherwise -- a photograph that has been through a
 * messaging app has no capture time, and putting all of those together at
 * one end of the list would be worse than using the next best thing.
 *
 * Both are reduced to a wall clock in the reader's own zone, so the two
 * sort against each other sensibly: EXIF is the camera's local time with
 * no zone on it, while created_at is UTC.
 */
export function takenKey(item: Pick<MediaLike, 'metadata'> & { created_at: string }): string {
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  const taken = typeof meta['taken_at'] === 'string' ? meta['taken_at'] : '';
  const m = TAKEN_AT.exec(taken);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  const at = new Date(item.created_at);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * The capture time to show an organiser, in the camera's own clock.
 *
 * Deliberately not put through a Date: EXIF carries no zone, and the
 * time written on it is the local time where the photograph was taken.
 * Reading it as if it were the reader's zone would shift a wedding
 * photograph by an hour for anyone abroad. Null when the photograph
 * never carried one -- worth saying out loud in the panel, because the
 * list then has nothing to go on but when it was uploaded.
 */
export function takenAtLabel(item: Pick<MediaLike, 'metadata'>): string | null {
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  const m = TAKEN_AT.exec(typeof meta['taken_at'] === 'string' ? meta['taken_at'] : '');
  return m ? `${m[3]}/${m[2]}/${m[1]}, ${m[4]}:${m[5]}:${m[6]}` : null;
}

/**
 * Newest first, by when each photograph was taken.
 *
 * takenKey falls back to the upload time for a photograph that carries
 * no capture time, so the two sort together in one list rather than the
 * undated ones gathering at an end of it (asked 2026-09-27). For most of
 * them the upload time is the better guess anyway: a photograph sent
 * from a phone minutes after it was taken lands within minutes of it.
 */
export function compareTaken(
  a: Pick<MediaLike, 'metadata'> & { created_at: string },
  b: Pick<MediaLike, 'metadata'> & { created_at: string },
): number {
  return takenKey(b).localeCompare(takenKey(a));
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

/**
 * Who uploaded this, as something to group by.
 *
 * The invitation guest's id where there is one, because two guests can
 * share a name and a typed name can be spelled two ways; the folded name
 * otherwise, so photos from a guest who typed their name still gather
 * together. Null for anything an organiser uploaded.
 */
export function uploaderKey(item: Pick<MediaLike, 'metadata'>): string | null {
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  if (meta['source'] !== 'guest') return null;
  if (typeof meta['member_id'] === 'string' && meta['member_id']) return `member:${meta['member_id']}`;
  const name = typeof meta['guest_name'] === 'string' ? meta['guest_name'].trim().toLowerCase() : '';
  return name ? `name:${name}` : null;
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

/**
 * How the booth's own light has been lately.
 *
 * Every booth picture now records how bright the middle of the camera's
 * view was when it was taken (0-255). A run of dark ones is worth saying
 * out loud in the Media tab, because the fix is a lamp in the corner and
 * that helps more than anything the software does (asked 2026-09-28).
 */
export function boothLightReport(
  items: ReadonlyArray<Pick<MediaLike, 'metadata'> & { created_at: string }>,
  recent = 30,
): { looked: number; dark: number; message: string | null } {
  const lights = items
    .filter((i) => {
      const meta = (i.metadata ?? {}) as Record<string, unknown>;
      return typeof meta['light'] === 'number';
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, recent)
    .map((i) => ((i.metadata ?? {}) as Record<string, number>)['light']!);

  // Below seventy is about a stop under; the booth's own threshold.
  const dark = lights.filter((v) => v < 70).length;
  if (lights.length < 5 || dark * 2 < lights.length) {
    return { looked: lights.length, dark, message: null };
  }
  return {
    looked: lights.length,
    dark,
    message: `${dark} of the last ${lights.length} booth photos were taken in the dark. `
      + 'A lamp near the booth would do more for them than anything else.',
  };
}
