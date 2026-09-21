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
