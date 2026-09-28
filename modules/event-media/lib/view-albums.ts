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

export type View = 'seed' | 'night' | 'ready' | 'day' | 'evening' | 'booth' | 'elsewhere'

export const VIEWS: readonly View[] = ['seed', 'night', 'ready', 'day', 'evening', 'booth', 'elsewhere']

const RANK: Record<View, number> = {
  booth: 0, elsewhere: 1, evening: 2, day: 3, ready: 4, night: 5, seed: 6,
}

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
 * When the evening reception starts, as a wall clock on the day of the
 * event: half past six (asked 2026-09-28).
 *
 * A wall clock rather than an offset from the start, because that is what
 * an evening is -- a wedding that starts at half past one and one that
 * starts at four both have their evening reception at the same time of
 * day. Read in the same clock as everything else here: EXIF carries the
 * camera's own local time with no zone on it, and an event's start is
 * stored the same way, so the two compare directly.
 */
const EVENING_FROM_HOUR = 18
const EVENING_FROM_MINUTE = 30
/**
 * And when it stops being the evening: the same ceiling a booth picture
 * gets, fourteen hours after the start. A photograph taken at seven the
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
  const start = opts.eventStart ? atClock(opts.eventStart) : NaN
  if (!Number.isFinite(start)) return 'day'
  const taken = opts.takenAt ? atClock(opts.takenAt) : NaN
  const when = Number.isFinite(taken) ? taken : opts.now
  if (when >= start) return when >= eveningFrom(start) && when <= start + EVENING_UNTIL_HOURS * 3600_000
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
 * Where a booth picture lands.
 *
 * Guests kept using the booth at home afterwards, with their own
 * families, and those pictures were landing in the wedding's own album
 * (asked 2026-09-27). A booth picture is made at the moment the shutter
 * goes, so the clock is the whole story: made while the event was on, it
 * is the event's; made days later at a kitchen table, it is not.
 */
/**
 * Half past six on the day the event starts, as a time.
 *
 * An event that begins after that hour -- an evening do -- has no
 * separate evening: the whole of it is the day, so the boundary is its
 * own start and nothing lands before it.
 */
export function eveningFrom(start: number): number {
  const d = new Date(start)
  const at = Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    EVENING_FROM_HOUR, EVENING_FROM_MINUTE, 0, 0,
  )
  return Math.max(at, start)
}

export function boothAlbum(opts: { eventStart: string | null | undefined; now: number }): View {
  const start = opts.eventStart ? atClock(opts.eventStart) : NaN
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
