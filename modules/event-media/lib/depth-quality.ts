/**
 * Whether a photo's 3D layers can be trusted, and why not.
 *
 * The projector moves the background behind the people. That only looks
 * right when the layers are good, and three things go wrong often enough
 * to check every photo:
 *
 *   - the background plate still contains the people, because the
 *     inpainting had too little to work with (tight selfies)
 *   - something near the camera sits OUTSIDE the cutout, so it slides
 *     behind the people (pint glasses on a table, the floor underfoot)
 *   - something far away sits INSIDE the cutout, so it is drawn in front
 *     of things it is actually behind (people at the back of a room)
 *
 * These functions are pure: they take pixel data, not images. The
 * projector and the admin each read pixels their own way and get the
 * same verdict. The projector keeps its own copy of this arithmetic (see
 * CinematicPhoto.tsx) because a portal page importing runtime code from
 * here has no precedent in this repo, and a bad portal import takes the
 * whole portal down; a test pins the two sets of thresholds together.
 */

/** Mean luma change inside the subject mask below which the people were not removed. */
export const PLATE_MIN_CHANGE = 35
/** Depth-map units (0..255) that count as a different plane. */
export const AGREE_MARGIN = 38
/** Fraction of the frame that may be near-but-outside the cutout. */
export const MAX_NEAR_OUTSIDE = 0.05
/** Fraction of the cutout that may be far-but-inside it. */
export const MAX_FAR_INSIDE = 0.08

/** RGBA pixel data, four bytes per pixel. */
export type Rgba = ArrayLike<number>

const luma = (d: Rgba, i: number) => 0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!

/**
 * How much the plate differs from the original inside the subject mask,
 * 0..255. Returns 255 when the mask is too small to judge, so a photo is
 * not flattened on no evidence -- the projector does the same.
 */
export function plateChangeScore(photo: Rgba, plate: Rgba, mask: Rgba, pixels: number): number {
  let sum = 0
  let n = 0
  for (let i = 0; i < pixels; i++) {
    if (mask[i * 4 + 3]! < 160) continue
    sum += Math.abs(luma(photo, i) - luma(plate, i))
    n++
  }
  return n < 64 ? 255 : sum / n
}

/**
 * How far the cutout disagrees with the depth map. Returns zeros when
 * there is too little of either side to judge, as the projector does.
 */
export function layerAgreementScore(
  depth: Rgba, mask: Rgba, pixels: number,
): { nearOutside: number; farInside: number } {
  const inside: number[] = []
  const outside: number[] = []
  for (let i = 0; i < pixels; i++) (mask[i * 4 + 3]! > 160 ? inside : outside).push(depth[i * 4]!)
  if (inside.length < 64 || outside.length < 64) return { nearOutside: 0, farInside: 0 }
  inside.sort((a, b) => a - b)
  // The subject's own depth: the middle of what the cutout claims.
  const subj = inside[Math.floor(inside.length / 2)]!
  return {
    farInside: inside.filter((v) => v < subj - AGREE_MARGIN * 1.6).length / inside.length,
    nearOutside: outside.filter((v) => v >= subj - AGREE_MARGIN * 0.3).length / pixels,
  }
}

export interface DepthVerdict {
  /** True when the projector will move the background behind the people. */
  parallax: boolean
  /** Plain-English reasons it will not, empty when it will. */
  reasons: string[]
}

/**
 * The same decision the projector makes, with its reasons spelt out.
 * A missing depth map is a failure, not a pass: layers that cannot be
 * verified are not used.
 */
export function depthVerdict(input: {
  hasPlate: boolean
  hasCutout: boolean
  hasDepth: boolean
  plateChange: number | null
  agreement: { nearOutside: number; farInside: number } | null
}): DepthVerdict {
  const reasons: string[] = []
  if (!input.hasPlate || !input.hasCutout) reasons.push('The background and people layers have not been generated.')
  if (!input.hasDepth) reasons.push('There is no depth map, so the layers cannot be checked.')
  if (input.plateChange !== null && input.plateChange < PLATE_MIN_CHANGE) {
    reasons.push('The background layer still contains the people, so they would slide over themselves.')
  }
  if (input.agreement) {
    if (input.agreement.nearOutside > MAX_NEAR_OUTSIDE) {
      reasons.push('Something near the camera is outside the people layer, so it would slide behind them.')
    }
    if (input.agreement.farInside > MAX_FAR_INSIDE) {
      reasons.push('People or things at the back are inside the people layer, so they would be drawn in front.')
    }
  } else if (input.hasDepth && input.hasCutout) {
    reasons.push('The depth map could not be read.')
  }
  return { parallax: reasons.length === 0, reasons }
}
