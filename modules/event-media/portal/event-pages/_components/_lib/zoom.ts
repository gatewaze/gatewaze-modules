/**
 * Pinching a photograph in the lightbox.
 *
 * The portal cannot rely on the browser for this. Both of the host app's
 * layouts set `userScalable: false`, so pinch-to-zoom is off for every
 * page of every tenant's portal and no amount of `touch-action` in a
 * module overrides it. Changing that would turn page zoom on everywhere
 * for everyone to fix one photo viewer, so the viewer does its own
 * (reported 2026-10-17).
 *
 * All of it is arithmetic on a scale and an offset, which is why it is
 * here rather than in the component: the formulae are the part that is
 * easy to get subtly wrong and impossible to eyeball.
 */

export interface Zoom {
  /** 1 is fit-to-screen. */
  scale: number
  /** Where the photograph has been dragged to, in screen pixels. */
  x: number
  y: number
}

export const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 }

/** Never smaller than the frame, never past the point of pointlessness. */
export const MIN_SCALE = 1
export const MAX_SCALE = 6

/** What a double tap zooms to. */
export const TAP_SCALE = 2.5

/** Two taps closer together than this, and nearer than TAP_NEAR, are one gesture. */
export const DOUBLE_TAP_MS = 300
export const TAP_NEAR_PX = 32

export const clampScale = (s: number): number => (
  !Number.isFinite(s) ? MIN_SCALE : Math.max(MIN_SCALE, Math.min(MAX_SCALE, s))
)

/** The distance between two fingers. */
export function spread(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const d = Math.hypot(dx, dy)
  return Number.isFinite(d) ? d : 0
}

/** The point between two fingers. */
export function midpoint(
  a: { x: number; y: number }, b: { x: number; y: number },
): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * Scale about a point, keeping whatever is under that point under it.
 *
 * This is the whole trick of a pinch: zooming about the centre of the
 * frame instead of the centre of the fingers is what makes a zoom feel
 * like it is fighting you.
 *
 * `at` is the anchor in screen pixels measured from the centre of the
 * frame -- the same origin the offset uses, since the photograph is
 * centred and transformed about its middle.
 *
 * Derivation: a content point `c` appears at `c * s + t`. The content
 * under the anchor is `c = (at - t) / s`. To keep it under `at` at the
 * new scale, `at = c * s2 + t2`, so `t2 = at - (at - t) * s2 / s`.
 */
export function scaleAbout(
  at: { x: number; y: number }, from: Zoom, toScale: number,
): Zoom {
  const s = from.scale > 0 ? from.scale : 1
  const s2 = clampScale(toScale)
  const k = s2 / s
  return {
    scale: s2,
    x: at.x - (at.x - from.x) * k,
    y: at.y - (at.y - from.y) * k,
  }
}

/**
 * Keep the photograph over the frame.
 *
 * An axis whose scaled size is no bigger than the frame is pinned to the
 * middle -- letting a photograph that already fits wander around the
 * screen is the other half of a zoom feeling broken. Otherwise it may
 * travel by half the overhang, which is exactly far enough to bring each
 * edge to the edge of the frame and no further.
 */
export function clampPan(
  z: Zoom, frame: { w: number; h: number }, content: { w: number; h: number },
): Zoom {
  const limit = (offset: number, frameSize: number, contentSize: number): number => {
    const over = contentSize * z.scale - frameSize
    if (!Number.isFinite(over) || over <= 0) return 0
    const max = over / 2
    return Math.max(-max, Math.min(max, Number.isFinite(offset) ? offset : 0))
  }
  return {
    scale: z.scale,
    x: limit(z.x, frame.w, content.w),
    y: limit(z.y, frame.h, content.h),
  }
}

/** Back to fit, with nothing left over. */
export function settle(
  z: Zoom, frame: { w: number; h: number }, content: { w: number; h: number },
): Zoom {
  if (z.scale <= MIN_SCALE) return NO_ZOOM
  return clampPan(z, frame, content)
}

/** Is this a zoom, or is the photograph sitting as it was? */
export const isZoomed = (z: Zoom): boolean => z.scale > MIN_SCALE + 0.01

/**
 * Was that a double tap?
 *
 * Both halves matter: two taps in quick succession at opposite corners
 * are two taps, not a gesture.
 */
export function isDoubleTap(
  last: { at: number; x: number; y: number } | null,
  now: { at: number; x: number; y: number },
): boolean {
  if (!last) return false
  if (now.at - last.at > DOUBLE_TAP_MS || now.at < last.at) return false
  return spread(last, now) <= TAP_NEAR_PX
}
