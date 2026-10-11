/**
 * Dragging one photograph aside to bring in the next.
 *
 * A gallery on a phone should feel like a photo roll: the picture follows
 * the finger and the next one comes in behind it, rather than a swipe
 * being detected and something happening afterwards (asked 2026-09-28).
 * Following the finger is most of the work; this is the part that has to
 * decide, when the finger lifts, whether the photograph goes or springs
 * back -- and that decision is easy to get subtly wrong, so it lives
 * here where it can be tested.
 */

export interface SwipeEnd {
  /** How far it was dragged, in pixels. Negative is leftwards. */
  dx: number
  /** How long the drag took, in milliseconds. */
  ms: number
  /** The width of the picture being dragged. */
  width: number
}

export type SwipeVerdict = 'next' | 'previous' | 'stay'

/** Past a third of the way across, it goes. */
const DISTANCE = 0.3
/**
 * Or a flick: a short, fast movement, even a small one. 0.5px/ms is
 * about a phone's idea of a deliberate flick and well above the drift of
 * a finger that was only tapping.
 */
const FLICK_SPEED = 0.5
const FLICK_MIN_PX = 40

export function swipeVerdict({ dx, ms, width }: SwipeEnd): SwipeVerdict {
  if (!Number.isFinite(dx) || !Number.isFinite(width) || width <= 0) return 'stay'
  const far = Math.abs(dx) > width * DISTANCE
  const speed = ms > 0 ? Math.abs(dx) / ms : 0
  const flicked = speed >= FLICK_SPEED && Math.abs(dx) >= FLICK_MIN_PX
  if (!far && !flicked) return 'stay'
  // Dragging left brings in the one after: the roll moves under the
  // finger, so the picture leaves the way the finger went.
  return dx < 0 ? 'next' : 'previous'
}

/**
 * How far the picture actually moves, given how far the finger has.
 *
 * At the ends of the album there is nothing to bring in, so the picture
 * resists instead of sliding off into nothing -- the same rubber band a
 * phone gives you at the end of a list, which says "there is no more"
 * without a message saying it.
 */
export function dragOffset(dx: number, opts: { atStart: boolean; atEnd: boolean }): number {
  if (!Number.isFinite(dx)) return 0
  const pulling = (dx > 0 && opts.atStart) || (dx < 0 && opts.atEnd)
  return pulling ? dx * 0.25 : dx
}

/** A drag this small was somebody tapping. */
export const TAP_SLOP_PX = 8
