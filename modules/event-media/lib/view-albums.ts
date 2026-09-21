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

export type View = 'seed' | 'ready' | 'day' | 'booth'

export const VIEWS: readonly View[] = ['seed', 'ready', 'day', 'booth']

const RANK: Record<View, number> = { booth: 0, day: 1, ready: 2, seed: 3 }

/**
 * Where a new upload lands.
 *
 * Guests upload the same way all day and never choose. The booth's
 * posters go to the booth; everything else is Getting ready until the
 * event starts and The day from then on. An event with no usable start
 * time has no before, so everything is The day.
 */
export function albumForUpload(opts: { booth: boolean; eventStart: string | null | undefined; now: number }): View {
  if (opts.booth) return 'booth'
  const start = opts.eventStart ? Date.parse(opts.eventStart) : NaN
  return Number.isFinite(start) && opts.now < start ? 'ready' : 'day'
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
