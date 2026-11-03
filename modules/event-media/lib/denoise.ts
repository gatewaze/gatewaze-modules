/**
 * Taking the speckle out of a photograph shot in a dark room.
 *
 * A phone in a marquee at eleven at night is running its sensor hard,
 * and what comes back has two kinds of noise in it. They are not equally
 * worth removing:
 *
 *   CHROMA noise -- red and green speckle in the shadows -- is pure
 *   nuisance. Nothing in a photograph is actually that colour, the eye
 *   reads it as dirt, and it can be removed outright because colour
 *   carries almost no detail: human vision resolves brightness several
 *   times more finely than hue. This is what television has exploited
 *   for seventy years.
 *
 *   LUMA noise -- brightness grain -- sits on top of real detail, and
 *   removing it takes the detail with it. That is the smeared, waxy look
 *   that marks out an over-denoised photograph. So this touches it
 *   barely, and only where there is no edge.
 *
 * Measured on 2026-10-01: the guests' photographs carry grain of 6.76
 * against the photographer's 5.70, and the enhancement was pushing it
 * UP to 9.35 by stretching contrast on noisy files.
 *
 * No model, nothing invented: every output pixel is a weighted sum of
 * its neighbours.
 */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** How far chroma is smoothed, in pixels, at full strength. */
const CHROMA_RADIUS = 3;
/** The most luma is ever smoothed, where nothing is happening. */
const LUMA_MAX = 0.45;
/** Above this local contrast, luma is left entirely alone. */
const EDGE = 14;

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const span = 2 * r + 1;
  for (let y = 0; y < h; y += 1) {
    let acc = 0;
    for (let x = -r; x <= r; x += 1) acc += src[y * w + clamp(x, 0, w - 1)]!;
    for (let x = 0; x < w; x += 1) {
      tmp[y * w + x] = acc / span;
      acc += src[y * w + clamp(x + r + 1, 0, w - 1)]! - src[y * w + clamp(x - r, 0, w - 1)]!;
    }
  }
  for (let x = 0; x < w; x += 1) {
    let acc = 0;
    for (let y = -r; y <= r; y += 1) acc += tmp[clamp(y, 0, h - 1) * w + x]!;
    for (let y = 0; y < h; y += 1) {
      out[y * w + x] = acc / span;
      acc += tmp[clamp(y + r + 1, 0, h - 1) * w + x]! - tmp[clamp(y - r, 0, h - 1) * w + x]!;
    }
  }
  return out;
}

/**
 * How noisy this photograph is: the median absolute difference between
 * neighbouring pixels, which a smooth photograph answers near zero and a
 * grainy one answers high.
 */
export function noiseLevel(data: Uint8ClampedArray, width: number, height: number): number {
  if (width < 4 || height < 4) return 0;
  const diffs: number[] = [];
  for (let y = 1; y < height - 1; y += 3) {
    for (let x = 1; x < width - 1; x += 3) {
      const i = (y * width + x) * 4;
      const l = (p: number) => 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!;
      const here = l(i);
      const around = (l(i - 4) + l(i + 4) + l(i - width * 4) + l(i + width * 4)) / 4;
      diffs.push(Math.abs(here - around));
    }
  }
  if (diffs.length === 0) return 0;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)]!;
}

/**
 * Clean a photograph, in place.
 *
 * `strength` 0..1 scales how far chroma is taken; the luma side is held
 * deliberately light whatever is asked for, because the failure mode of
 * denoising faces is worse than the noise.
 */
export function denoise(
  data: Uint8ClampedArray, width: number, height: number, strength = 1,
): void {
  const n = width * height;
  if (n === 0 || data.length < n * 4) return;
  const s = clamp(strength, 0, 1);
  if (s <= 0) return;

  const Y = new Float32Array(n);
  const Cb = new Float32Array(n);
  const Cr = new Float32Array(n);
  for (let p = 0; p < n; p += 1) {
    const i = p * 4;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    Y[p] = y;
    Cb[p] = b - y;
    Cr[p] = r - y;
  }

  // Colour: smoothed hard. It carries almost no detail.
  const r = Math.max(1, Math.round(CHROMA_RADIUS * s));
  const cb = boxBlur(Cb, width, height, r);
  const cr = boxBlur(Cr, width, height, r);

  // Brightness: smoothed only where there is no edge to lose.
  const yBlur = boxBlur(Y, width, height, 1);
  for (let p = 0; p < n; p += 1) {
    const detail = Math.abs(Y[p]! - yBlur[p]!);
    const flat = 1 - clamp(detail / EDGE, 0, 1);
    const mix = LUMA_MAX * s * flat;
    const y = Y[p]! * (1 - mix) + yBlur[p]! * mix;
    const B = y + cb[p]!;
    const R = y + cr[p]!;
    const G = (y - 0.299 * R - 0.114 * B) / 0.587;
    const i = p * 4;
    data[i] = R;
    data[i + 1] = G;
    data[i + 2] = B;
  }
}
