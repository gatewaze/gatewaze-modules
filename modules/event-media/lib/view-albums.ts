/**
 * Which projector view a photo belongs to.
 *
 * Each event has a view album per stream (migrations 006, 007, 014, 018,
 * 021): Preload, The night before, Getting ready, The day, Evening
 * reception and Photographer. Membership of those albums is
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
 * its tag wins. Between two such, the photographer, then the evening,
 * then the day, then Getting ready outrank Preload, which is the
 * stand-in stream.
 */

export type View =
  | 'seed' | 'night' | 'ready' | 'day' | 'evening' | 'photographer'

export const VIEWS: readonly View[] = [
  'seed', 'night', 'ready', 'day', 'evening', 'photographer',
]

const RANK: Record<View, number> = {
  photographer: 0, evening: 1, day: 2, ready: 3, night: 4, seed: 5,
}

/**
 * The evening before an event, and the morning of it.
 *
 * Measured back from the start rather than from a calendar day, because
 * an event that starts at half past one in the afternoon and one that
 * starts at seven in the evening have different mornings. Getting ready
 * is the twelve hours before it; the night before is the twelve hours
 * before that, which for a lunchtime start is the previous evening.
 */
const READY_HOURS = 12
const NIGHT_HOURS = 36

/**
 * When the evening reception starts, as a wall clock on the day of the
 * event: half past six (asked 2026-09-28).
 *
 * A wall clock rather than an offset from the start, because that is what
 * an evening is -- an event that starts at half past one and one that
 * starts at four both have their evening reception at the same time of
 * day. Read in the same clock as everything else here: EXIF carries the
 * camera's own local time with no zone on it, and an event's start is
 * stored the same way, so the two compare directly.
 */
export const EVENING_FROM_DEFAULT = 18 * 60 + 30
/**
 * And when it stops being the evening: fourteen hours after the start.
 * A photograph taken at seven the
 * following evening belongs to The day's catch-all, not to the party.
 */
const EVENING_UNTIL_HOURS = 14

/**
 * A time, read as the clock it was written on.
 *
 * EXIF has no timezone in it: "2026-09-25T18:30:00" is what the camera's
 * own clock said, and an event's start is stored the same way. Read
 * without saying so, a zone-less time means something different on every
 * machine -- the api pod runs in UTC and a laptop in London does not, and
 * the same photograph would land in a different album depending on which
 * one filed it. So a time with no zone on it is read as the clock it was
 * written on, which is the only reading that is the same everywhere.
 */
function atClock(value: string): number {
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value.trim())
  return Date.parse(zoned ? value : `${value.trim()}Z`)
}

/**
 * Where a new upload lands.
 *
 * Guests upload the same way all day and never choose. A guest's
 * photograph is Getting ready until the event starts and The day from
 * then on. An event with no usable start
 * time has no before, so everything is The day.
 */
export function albumForUpload(opts: {
  /**
   * Delivered by the photographer rather than taken by a guest. Their
   * album is not decided by the hour: a professional's photographs are
   * theirs wherever in the day they were taken.
   */
  photographer?: boolean
  eventStart: string | null | undefined
  now: number
  /**
   * When the photograph was taken, from its own EXIF. Someone emptying
   * their camera roll on the Sunday should still find their morning
   * photographs under Getting ready (asked 2026-09-27), so this decides
   * when it is known and the clock only stands in when it is not.
   */
  takenAt?: string | null
  /**
   * When the evening reception starts, minutes past midnight. An event
   * whose reception begins at five does not want half past six (asked
   * 2026-09-28). Absent means half past six.
   */
  eveningFromMinutes?: number | null
}): View {
  if (opts.photographer) return 'photographer'
  const start = opts.eventStart ? atClock(opts.eventStart) : NaN
  if (!Number.isFinite(start)) return 'day'
  const taken = opts.takenAt ? atClock(opts.takenAt) : NaN
  const when = Number.isFinite(taken) ? taken : opts.now
  if (when >= start) return when >= eveningFrom(start, opts.eveningFromMinutes)
    && when <= start + EVENING_UNTIL_HOURS * 3600_000
    ? 'evening'
    : 'day'
  if (when >= start - READY_HOURS * 3600_000) return 'ready'
  if (when >= start - NIGHT_HOURS * 3600_000) return 'night'
  // Older than the night before: an upload from the camera roll that
  // has nothing to do with the run-up. It joins the day's photographs,
  // where it can be moved by hand if it does not belong.
  return 'day'
}

/**
 * Half past six on the day the event starts, as a time.
 *
 * An event that begins after that hour -- an evening do -- has no
 * separate evening: the whole of it is the day, so the boundary is its
 * own start and nothing lands before it.
 */
export function eveningFrom(start: number, fromMinutes?: number | null): number {
  const mins = Number.isFinite(fromMinutes) && (fromMinutes as number) >= 0 && (fromMinutes as number) < 1440
    ? Math.floor(fromMinutes as number)
    : EVENING_FROM_DEFAULT
  const d = new Date(start)
  const at = Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    Math.floor(mins / 60), mins % 60, 0, 0,
  )
  return Math.max(at, start)
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
