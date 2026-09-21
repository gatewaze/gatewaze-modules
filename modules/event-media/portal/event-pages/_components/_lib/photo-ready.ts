/**
 * Is a photograph finished enough to put on the projector?
 *
 * A guest's upload becomes a row the moment the bytes land, but its
 * layers and its browse copy are generated afterwards and take the best
 * part of a minute. Shown too early it pans across with no depth and no
 * title, then silently acquires both — which looks like a fault rather
 * than like something still arriving.
 *
 * The guest's own gallery is deliberately NOT gated on this. Someone
 * who has just uploaded a photo should see it immediately; it is only
 * the projector that waits.
 */

export interface ReadyCandidate {
  variants?: Record<string, string> | null
  card?: unknown
  created_at?: string | null
}

/**
 * How long to wait before showing a photo that never finished.
 *
 * Processing normally lands well inside a minute. This is the backstop
 * for the night the provider is slow, out of credit, or refusing one
 * particular image: a wedding guest's photograph reaching the screen
 * plainly beats it never arriving because a background job failed.
 */
export const PROCESSING_GRACE_MS = 4 * 60 * 1000

/** Everything the display wants before a photo is worth showing. */
export function isProcessed(p: ReadyCandidate): boolean {
  const v = p.variants ?? {}
  return Boolean(v['plate'] && v['cutout'] && p.card)
}

export function isReady(p: ReadyCandidate, now: number = Date.now()): boolean {
  if (isProcessed(p)) return true
  const t = p.created_at ? Date.parse(p.created_at) : NaN
  // An unparseable or missing timestamp must not strand the photo.
  if (!Number.isFinite(t)) return true
  return now - t > PROCESSING_GRACE_MS
}

/**
 * Split a pool into what the projector may show and what it is still
 * waiting on, so the display can say so rather than appearing stuck.
 */
export function partitionReady<T extends ReadyCandidate>(
  list: T[],
  now: number = Date.now(),
): { ready: T[]; pending: T[] } {
  const ready: T[] = []
  const pending: T[] = []
  for (const p of list) (isReady(p, now) ? ready : pending).push(p)
  return { ready, pending }
}

export interface CardCandidate {
  album?: string | null
  card?: { title?: unknown } | null
}

/**
 * Will this photo actually be billed as a programme in Wedflix?
 *
 * Wedflix is only worth putting on screen as Wedflix: a slide with no
 * browse card, in a mode whose whole point is the browse card, just
 * looks like the effect failed. So in Wedflix the pool is the photos
 * that get a card, and nothing else.
 *
 * Seed selfies are never billed, by design — they are stand-ins shown
 * as plain cinematic until real photographs arrive — so they are not
 * eligible even though they carry generated copy.
 */
export function hasBrowseCard(p: CardCandidate): boolean {
  if (p.album === 'seed' || !p.album) return false
  const title = p.card?.title
  return typeof title === 'string' && title.trim().length > 0
}

/**
 * Where the next incremental poll should start.
 *
 * The feed returns rows at or after a timestamp, and the display used to
 * ask only for rows newer than its newest -- so a photo first seen while
 * still processing was never fetched again, and sat "not ready" on the
 * projector until someone refreshed the page (booth screen, 2026-09-21).
 * Reaching back to the oldest photo still processing re-delivers it with
 * its finished layers. Photos past the grace window are shown anyway, so
 * they stop holding the window open.
 */
export function pollAfter<T extends ReadyCandidate>(
  items: T[],
  newest: string | null,
  now: number = Date.now(),
): string | null {
  let earliest = newest
  for (const p of items) {
    if (isProcessed(p) || !p.created_at) continue
    const t = Date.parse(p.created_at)
    if (!Number.isFinite(t) || now - t > PROCESSING_GRACE_MS) continue
    if (earliest === null || p.created_at < earliest) earliest = p.created_at
  }
  return earliest
}

export interface FeedFields extends ReadyCandidate {
  album?: string | null
}

/** Has the feed's copy of a photo moved on from the one on screen? */
export function feedChanged(held: FeedFields, incoming: FeedFields): boolean {
  const a = held.variants ?? {}
  const b = incoming.variants ?? {}
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (a[k] !== b[k]) return true
  if (Boolean(held.card) !== Boolean(incoming.card)) return true
  if (held.card && incoming.card && JSON.stringify(held.card) !== JSON.stringify(incoming.card)) return true
  return (held.album ?? null) !== (incoming.album ?? null)
}
