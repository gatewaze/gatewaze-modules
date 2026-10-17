/**
 * Where the faces are, and what that is worth.
 *
 * Boxes only. Nothing here identifies anybody, nothing here can tell one
 * person from another, and there is deliberately no embedding in sight:
 * a rectangle is personal data, a face template is Article 9 biometric
 * data, and the gap between them is the reason this half can ship on its
 * own.
 *
 * Two things it buys immediately:
 *
 *   * A crop that keeps the heads. `cropTo` in lib/framing.ts guesses
 *     with a fixed bias of 0.38 down the frame, because it has no idea
 *     what is in the picture. Where faces are known it does not have to
 *     guess.
 *   * A cover worth looking at, by asking which photograph in an album
 *     has people in it, large, and not sliced by the edge of the frame.
 *
 * Boxes are FRACTIONS of the frame, never pixels. The same photograph is
 * served at half a dozen widths through the CDN, and a box in pixels is
 * wrong at every width but one.
 */

/** A face, as a fraction of the frame it was found in. */
export interface FaceBox {
  x: number
  y: number
  w: number
  h: number
  score: number
  /** The long edge of the face in the ORIGINAL's pixels, where known. */
  px?: number | null
}

/** A rectangle in pixels. Same shape as lib/framing.ts uses. */
export interface PixelBox { x: number; y: number; w: number; h: number }

/**
 * A face smaller than this fraction of the frame is somebody in a crowd
 * rather than a subject. Still recorded, still counted -- just not
 * allowed to drag a crop around.
 */
export const MINOR_FACE = 0.02

/** Below this the detector is guessing. */
export const MIN_SCORE = 0.5

/**
 * How much of a face's own height to leave above the topmost head.
 *
 * A crop that touches the scalp reads as a mistake even when the whole
 * face is inside it, which is the single most common way an automatic
 * crop looks automatic.
 */
const HEADROOM = 0.45

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * A detector's pixel box, as a fraction of the frame it was found in.
 *
 * The frame is whatever was fed to the detector, which is a SMALL copy --
 * detection runs at around 640px, not on a twelve-megapixel original --
 * so this is also what makes the answer independent of that choice.
 */
export function normaliseBox(
  box: { x: number; y: number; w: number; h: number },
  frame: { w: number; h: number },
): { x: number; y: number; w: number; h: number } | null {
  if (!finite(frame.w) || !finite(frame.h) || frame.w <= 0 || frame.h <= 0) return null
  if (!finite(box.x) || !finite(box.y) || !finite(box.w) || !finite(box.h)) return null
  if (box.w <= 0 || box.h <= 0) return null
  return {
    // Clamped to the range the column's CHECK allows: a detector will
    // report a face half out of shot, which is true, but not one a whole
    // frame away.
    x: clamp(box.x / frame.w, -0.5, 1.5),
    y: clamp(box.y / frame.h, -0.5, 1.5),
    w: clamp(box.w / frame.w, 1e-6, 2),
    h: clamp(box.h / frame.h, 1e-6, 2),
  }
}

/** The faces worth letting influence anything. */
export function significant(faces: readonly FaceBox[]): FaceBox[] {
  return faces.filter((f) => (
    finite(f.w) && finite(f.h)
    && f.score >= MIN_SCORE
    && Math.max(f.w, f.h) >= MINOR_FACE
  ))
}

/** The one box that contains every face given, or null for none. */
export function faceSpan(faces: readonly FaceBox[]): { x: number; y: number; w: number; h: number } | null {
  const use = significant(faces)
  if (use.length === 0) return null
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity
  for (const f of use) {
    x0 = Math.min(x0, f.x)
    y0 = Math.min(y0, f.y)
    x1 = Math.max(x1, f.x + f.w)
    y1 = Math.max(y1, f.y + f.h)
  }
  if (![x0, y0, x1, y1].every(finite)) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * Slide a window of fixed size so it holds as much of `want` as it can.
 *
 * Where the window is big enough, it is moved the least distance that
 * contains the target. Where it is not, it centres on the target instead
 * of clinging to one edge -- a group too wide for a 2:3 crop should lose
 * both ends evenly, not have the left-hand guests cut off entirely.
 */
function slide(windowSize: number, limit: number, want: { at: number; size: number }): number {
  if (windowSize >= limit) return 0
  if (want.size >= windowSize) {
    const centre = want.at + want.size / 2
    return clamp(centre - windowSize / 2, 0, limit - windowSize)
  }
  const lo = want.at + want.size - windowSize   // furthest left that still contains it
  const hi = want.at                            // furthest right
  return clamp(clamp(0, lo, hi), 0, limit - windowSize)
}

/**
 * The largest box of `ratio` inside the photograph that keeps the faces.
 *
 * With no faces -- an empty room, a cake, a detector that found nothing --
 * this is exactly `cropTo`'s answer, so it is safe to use everywhere.
 *
 * `faces` are fractions of the frame; the answer is in pixels, like the
 * rest of lib/framing.ts.
 */
export function cropToFaces(
  w: number, h: number, ratio: number, faces: readonly FaceBox[], biasY = 0.38,
): PixelBox {
  const whole: PixelBox = { x: 0, y: 0, w: Math.max(1, w), h: Math.max(1, h) }
  if (!finite(w) || !finite(h) || w <= 0 || h <= 0 || !(ratio > 0)) return whole

  const have = w / h
  if (Math.abs(have - ratio) < 1e-6) return { x: 0, y: 0, w, h }

  // The window is the same size whatever is in the picture; only where
  // it sits changes.
  const nw = have > ratio ? Math.max(1, Math.round(h * ratio)) : w
  const nh = have > ratio ? h : Math.max(1, Math.round(w / ratio))

  const span = faceSpan(faces)
  if (!span) {
    // No faces: the old rule, unchanged.
    return have > ratio
      ? { x: Math.round((w - nw) / 2), y: 0, w: nw, h }
      : { x: 0, y: Math.round((h - nh) * biasY), w, h: nh }
  }

  // Into pixels, with a little room above the heads.
  const top = Math.max(0, span.y * h - span.h * h * HEADROOM)
  const want = {
    x: span.x * w,
    y: top,
    w: span.w * w,
    h: (span.y * h - top) + span.h * h,
  }

  return {
    x: Math.round(slide(nw, w, { at: want.x, size: want.w })),
    y: Math.round(slide(nh, h, { at: want.y, size: want.h })),
    w: nw,
    h: nh,
  }
}

/**
 * How well a photograph would serve as an album's cover.
 *
 * People, large, looking like they are in the picture on purpose. Zero
 * means nothing worth putting on a cover, and a photograph with no faces
 * scores zero rather than being excluded -- an album of the cake and the
 * flowers still needs a cover.
 */
export function coverScore(faces: readonly FaceBox[]): number {
  const use = significant(faces)
  if (use.length === 0) return 0
  const biggest = use.reduce((m, f) => Math.max(m, Math.max(f.w, f.h)), 0)
  // A couple beats a crowd, and a crowd beats one stranger at the edge.
  const company = Math.min(use.length, 6) / 6
  // A face sliced by the edge of the frame is not a cover.
  const whole = use.every((f) => f.x >= -0.02 && f.y >= -0.02 && f.x + f.w <= 1.02 && f.y + f.h <= 1.02)
  const confidence = use.reduce((m, f) => m + f.score, 0) / use.length
  return clamp(biggest, 0, 1) * 0.5 + company * 0.2 + confidence * 0.2 + (whole ? 0.1 : 0)
}
