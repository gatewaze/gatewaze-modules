/**
 * The shape a photograph is delivered in.
 *
 * Measured on 2026-09-29 across a professional wedding photographer's
 * published work and the guests' own photographs of the same wedding:
 *
 *     set                n    portrait  landscape  commonest shapes
 *     his portfolio      80     32%        67%     3:2 x54, 2:3 x25
 *     the guests' own    27     77%        22%     3:4 x19, 4:3 x6
 *
 * Seventy-nine of his eighty frames are 3:2 or 2:3 -- the 35mm shape a
 * camera gives you. The guests' are 3:4 and 4:3, the shape a phone gives
 * you. It is a real part of why one set reads as professional and the
 * other does not, and unlike everything else about his framing it costs
 * nothing to match: going from 3:4 to 2:3 is a crop of about a ninth of
 * the width, and no pixel is invented.
 *
 * What this deliberately does NOT try to fix is how much of the frame the
 * subject fills. His faces occupy 13% of frame height; the guests' occupy
 * 27%. He stood further back and put the room in the photograph. A crop
 * can only ever make a subject bigger, so that difference is not
 * reachable from here -- and reaching it by generation would mean
 * inventing most of the picture, which is a different photograph rather
 * than a better version of this one.
 *
 * Placement is already right: rule-of-thirds 74% against his 75%, off
 * centre 16.7% against his 15.2%, headroom 22.2% against his 22.2%. The
 * guests compose as well as he does. They just stand closer.
 */

/** The 35mm shapes, as width over height. */
export const CLASSIC = { landscape: 3 / 2, portrait: 2 / 3, square: 1 };

/** A rectangle inside, or around, a photograph. */
export interface Box { x: number; y: number; w: number; h: number }

/** How square a photograph has to be before it is left as a square. */
const SQUARE_BAND = 0.06;

/**
 * The shape this photograph should become: the 35mm ratio nearest the one
 * it already has, so a portrait stays a portrait.
 */
export function classicFor(w: number, h: number): number {
  if (w <= 0 || h <= 0) return CLASSIC.landscape;
  const ratio = w / h;
  if (Math.abs(ratio - 1) <= SQUARE_BAND) return CLASSIC.square;
  return ratio > 1 ? CLASSIC.landscape : CLASSIC.portrait;
}

const round = (v: number) => Math.max(1, Math.round(v));

/**
 * The largest box of `ratio` that fits inside the photograph.
 *
 * `biasY` decides where the loss falls when height is being cut: 0.5
 * takes it evenly, lower takes less from the top. Heads live in the top
 * half of a photograph of people, so the default leaves them alone and
 * takes the floor instead.
 */
export function cropTo(w: number, h: number, ratio: number, biasY = 0.38): Box {
  if (w <= 0 || h <= 0 || !(ratio > 0)) return { x: 0, y: 0, w: Math.max(1, w), h: Math.max(1, h) };
  const have = w / h;
  if (Math.abs(have - ratio) < 1e-6) return { x: 0, y: 0, w, h };
  if (have > ratio) {
    // Too wide: take it off the sides, evenly.
    const nw = round(h * ratio);
    return { x: Math.round((w - nw) / 2), y: 0, w: nw, h };
  }
  // Too tall: take it off the top and bottom, mostly the bottom.
  const nh = round(w / ratio);
  const spare = h - nh;
  return { x: 0, y: Math.round(spare * biasY), w, h: nh };
}

/**
 * The smallest box of `ratio` that CONTAINS the photograph, and where the
 * photograph sits inside it.
 *
 * The other way to change shape: instead of throwing away a ninth of the
 * width, add a ninth of the height. Nothing of the photograph is lost,
 * and everything added is outside it -- which is what makes it safe to
 * have a model fill, since the original can be laid back over the result
 * and nothing it invented can touch a face.
 */
export function expandTo(w: number, h: number, ratio: number): { box: Box; at: { x: number; y: number } } {
  if (w <= 0 || h <= 0 || !(ratio > 0)) {
    return { box: { x: 0, y: 0, w: Math.max(1, w), h: Math.max(1, h) }, at: { x: 0, y: 0 } };
  }
  const have = w / h;
  if (Math.abs(have - ratio) < 1e-6) return { box: { x: 0, y: 0, w, h }, at: { x: 0, y: 0 } };
  if (have > ratio) {
    // Too wide for the target: grow downwards and upwards.
    const nh = round(w / ratio);
    return { box: { x: 0, y: 0, w, h: nh }, at: { x: 0, y: Math.round((nh - h) / 2) } };
  }
  // Too tall: grow sideways.
  const nw = round(h * ratio);
  return { box: { x: 0, y: 0, w: nw, h }, at: { x: Math.round((nw - w) / 2), y: 0 } };
}

/** How much of a photograph a crop to this shape would throw away, 0..1. */
export function lossFrom(w: number, h: number, ratio: number): number {
  if (w <= 0 || h <= 0) return 0;
  const box = cropTo(w, h, ratio);
  return Number((1 - (box.w * box.h) / (w * h)).toFixed(4));
}

/**
 * Whether reshaping this photograph is worth doing at all.
 *
 * A frame already within a few per cent of the shape, or one a crop would
 * take a quarter of, is left alone -- a panorama is a panorama and a
 * square was a choice.
 */
const MOST_WE_WILL_LOSE = 0.25;

export function worthReframing(w: number, h: number, ratio: number): boolean {
  if (w <= 0 || h <= 0) return false;
  const loss = lossFrom(w, h, ratio);
  return loss > 0.01 && loss <= MOST_WE_WILL_LOSE;
}
