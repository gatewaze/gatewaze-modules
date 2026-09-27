/**
 * Which projector view a photo belongs to.
 *
 * Each event has four view albums (migrations 006, 007): Preload,
 * Getting ready, The day and Photo booth. Membership of those albums is
 * what decides the view, so an organiser moves a photo between views by
 * moving it between albums in the Media tab.
 *
 * The photo's own tag, metadata.album, records where it first landed.
 * It is the fallback for a photo in no view album -- one removed from
 * all of them, or one whose join failed -- so nothing drops off the
 * projector because of an album edit.
 *
 * A photo in more than one view album was almost certainly ADDED to a
 * second one by an organiser who meant to move it, so a view other than
 * its tag wins. Between two such, the booth, then the day, then Getting
 * ready outrank Preload, which is the stand-in stream.
 */

export type View = 'seed' | 'night' | 'ready' | 'day' | 'booth' | 'elsewhere'

export const VIEWS: readonly View[] = ['seed', 'night', 'ready', 'day', 'booth', 'elsewhere']

const RANK: Record<View, number> = { booth: 0, elsewhere: 1, day: 2, ready: 3, night: 4, seed: 5 }

/**
 * The evening before an event, and the morning of it.
 *
 * Measured back from the start rather than from a calendar day, because
 * a wedding that starts at half past one in the afternoon and one that
 * starts at seven in the evening have different mornings. Getting ready
 * is the twelve hours before it; the night before is the twelve hours
 * before that, which for a lunchtime start is the previous evening.
 */
const READY_HOURS = 12
const NIGHT_HOURS = 36

/**
 * Where a new upload lands.
 *
 * Guests upload the same way all day and never choose. The booth's
 * posters go to the booth; everything else is Getting ready until the
 * event starts and The day from then on. An event with no usable start
 * time has no before, so everything is The day.
 */
export function albumForUpload(opts: {
  booth: boolean
  eventStart: string | null | undefined
  now: number
  /**
   * When the photograph was taken, from its own EXIF. Someone emptying
   * their camera roll on the Sunday should still find their morning
   * photographs under Getting ready (asked 2026-09-27), so this decides
   * when it is known and the clock only stands in when it is not.
   */
  takenAt?: string | null
}): View {
  if (opts.booth) return boothAlbum({ eventStart: opts.eventStart, now: opts.now })
  const start = opts.eventStart ? Date.parse(opts.eventStart) : NaN
  if (!Number.isFinite(start)) return 'day'
  const taken = opts.takenAt ? Date.parse(opts.takenAt) : NaN
  const when = Number.isFinite(taken) ? taken : opts.now
  if (when >= start) return 'day'
  if (when >= start - READY_HOURS * 3600_000) return 'ready'
  if (when >= start - NIGHT_HOURS * 3600_000) return 'night'
  // Older than the night before: an upload from the camera roll that
  // has nothing to do with the run-up. It joins the day's photographs,
  // where it can be moved by hand if it does not belong.
  return 'day'
}

/**
 * Where a booth picture lands.
 *
 * Guests kept using the booth at home afterwards, with their own
 * families, and those pictures were landing in the wedding's own album
 * (asked 2026-09-27). A booth picture is made at the moment the shutter
 * goes, so the clock is the whole story: made while the event was on, it
 * is the event's; made days later at a kitchen table, it is not.
 */
export function boothAlbum(opts: { eventStart: string | null | undefined; now: number }): View {
  const start = opts.eventStart ? Date.parse(opts.eventStart) : NaN
  if (!Number.isFinite(start)) return 'booth'
  const from = start - READY_HOURS * 3600_000
  const until = start + 14 * 3600_000
  return opts.now >= from && opts.now <= until ? 'booth' : 'elsewhere'
}

export function isView(v: unknown): v is View {
  return typeof v === 'string' && (VIEWS as readonly string[]).includes(v)
}

/** The tag as the feed has always read it: untagged rows are Preload. */
export function tagView(metadata: unknown): View {
  const tag = metadata && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>)['album']
    : undefined
  return isView(tag) ? tag : 'seed'
}

export function resolveViews(
  viewAlbums: ReadonlyArray<{ album_id: string; view: string }>,
  items: ReadonlyArray<{ album_id: string; media_id: string }>,
  tags: ReadonlyMap<string, View>,
): Map<string, View> {
  const viewOf = new Map<string, View>()
  for (const a of viewAlbums) if (isView(a.view)) viewOf.set(a.album_id, a.view)

  const member = new Map<string, Set<View>>()
  for (const i of items) {
    const v = viewOf.get(i.album_id)
    if (!v) continue
    let s = member.get(i.media_id)
    if (!s) { s = new Set(); member.set(i.media_id, s) }
    s.add(v)
  }

  const out = new Map<string, View>()
  for (const [id, tag] of tags) {
    const views = member.get(id)
    if (!views || views.size === 0) { out.set(id, tag); continue }
    const moved = [...views].filter((v) => v !== tag).sort((a, b) => RANK[a] - RANK[b])
    out.set(id, moved[0] ?? tag)
  }
  return out
}
