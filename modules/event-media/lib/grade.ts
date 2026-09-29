/**
 * Giving every photograph the same finish.
 *
 * lib/enhance.ts corrects a photograph against itself: it is too dark, so
 * lift it; the lift raised the blacks, so put them back. That makes each
 * photograph better and does nothing at all for consistency -- an album
 * of two hundred photographs corrected one at a time still looks like
 * two hundred different photographs.
 *
 * This is the other half. It measures a photograph and carries it
 * towards a reference: a look taken from real professional photographs
 * of this kind of event rather than from anybody's opinion. What it
 * mostly does in practice is take colour OUT. Measured on 2026-09-29
 * across a wedding's own albums:
 *
 *     set               mean   p5    p50    p95    sat   R/G   B/G
 *     photographer      156   13.9   161   255   0.174  1.046 0.946
 *     guests' own       100   17.6   105   195   0.329  1.185 0.885
 *     relit by a model   92    4.8    87   201   0.433  1.191 0.843
 *
 * The professional photographs are brighter, wider in tonal range, and
 * carry HALF the saturation. The relit copies carry two and a half times
 * it, which is what "the AI ones are over-saturated" turned out to mean
 * (reported 2026-09-29).
 *
 * Pure arithmetic, as the rest of the enhancement is: a gain, an offset,
 * a colour pull and a tint. Nothing is drawn.
 */
import type { EnhanceOps } from './enhance.js';

/** What a photograph measures, for grading it. */
export interface ToneProfile {
  /** Average brightness, 0..255. */
  mean: number;
  /** Fifth, fiftieth and ninety-fifth percentiles of brightness. */
  p5: number;
  p50: number;
  p95: number;
  /** Mean HSV saturation over pixels with light in them, 0..1. */
  sat: number;
  /** Colour balance as ratios to green. */
  rg: number;
  bg: number;
}

/**
 * The look every photograph is carried towards.
 *
 * Measured from twelve professional photographs of this wedding, at 400px
 * wide, on 2026-09-29. Not a preference: it is what the photographs a
 * couple actually pays for measure, and the point of a reference is that
 * it is somebody else's.
 */
export const HOUSE: ToneProfile = {
  mean: 156.2, p5: 13.9, p50: 160.8, p95: 255,
  sat: 0.174, rg: 1.046, bg: 0.946,
};

/**
 * How far towards the reference a photograph is carried.
 *
 * Tone is pulled least. The reference photographs are bright tipi
 * interiors with a white dress in them and their p95 is a clipped 255;
 * a dim corner of a marquee at eleven at night is not that photograph
 * and should not be forced to become it. Colour is pulled hardest --
 * an orange cast is not a mood, it is a fault, and it is the one
 * people notice.
 */
const TONE_PULL = 0.7;
const SAT_PULL = 0.8;
const WB_PULL = 0.8;

/** What a grade is allowed to do, so it stays a grade. */
const LIMITS = {
  multiplier: { lo: 0.8, hi: 2.0 },
  saturation: { lo: 0.45, hi: 1.3 },
  tint: { lo: 0.85, hi: 1.2 },
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Measure a photograph: brightness percentiles, saturation and colour
 * balance, in one pass over every eighth pixel.
 */
export function profileOf(data: Uint8ClampedArray): ToneProfile {
  if (data.length < 4) return { ...HOUSE };
  const bins = new Uint32Array(256);
  let n = 0, total = 0, r = 0, g = 0, b = 0, sat = 0, satN = 0;
  for (let i = 0; i < data.length; i += 32) {
    const R = data[i]!, G = data[i + 1]!, B = data[i + 2]!;
    const luma = 0.299 * R + 0.587 * G + 0.114 * B;
    bins[Math.max(0, Math.min(255, Math.round(luma)))]! += 1;
    total += luma;
    r += R; g += G; b += B;
    // A pixel with almost no light in it has no meaningful colour, and
    // including it drags the measurement towards zero.
    const mx = Math.max(R, G, B);
    if (mx > 20) { sat += (mx - Math.min(R, G, B)) / mx; satN += 1; }
    n += 1;
  }
  if (n === 0) return { ...HOUSE };
  const at = (q: number): number => {
    const want = n * q;
    let seen = 0;
    for (let v = 0; v < 256; v += 1) {
      seen += bins[v]!;
      if (seen >= want) return v;
    }
    return 255;
  };
  const safe = (v: number) => (v > 0.5 ? v : 1);
  return {
    mean: total / n,
    p5: at(0.05), p50: at(0.5), p95: at(0.95),
    sat: satN > 0 ? sat / satN : HOUSE.sat,
    rg: safe(r / n) / safe(g / n),
    bg: safe(b / n) / safe(g / n),
  };
}

/**
 * The adjustments that carry one photograph towards the reference.
 *
 * Tone is a levels match: the photograph's own fifth and ninety-fifth
 * percentiles are mapped onto the reference's, which sets a gain and an
 * offset together. Saturation and colour balance are pulled towards the
 * reference's by ratio.
 *
 * A photograph already close to the reference gets almost nothing --
 * measured on the wedding, one well-exposed daytime photograph moved
 * from 0.217 saturation to 0.201, while a booth selfie at 0.717 came
 * back to 0.331. That is the point: the finish is consistent because
 * what it does is whatever each photograph needs to get there.
 */
export function gradeFor(p: ToneProfile, ref: ToneProfile = HOUSE): EnhanceOps {
  const lo = p.p5 + (ref.p5 - p.p5) * TONE_PULL;
  const hi = p.p95 + (ref.p95 - p.p95) * TONE_PULL;
  const span = Math.max(1, p.p95 - p.p5);
  const multiplier = clamp((hi - lo) / span, LIMITS.multiplier.lo, LIMITS.multiplier.hi);
  const offset = lo - p.p5 * multiplier;

  const wantSat = p.sat + (ref.sat - p.sat) * SAT_PULL;
  const saturation = p.sat > 0.01
    ? clamp(wantSat / p.sat, LIMITS.saturation.lo, LIMITS.saturation.hi)
    : 1;

  const toward = (want: number, have: number) =>
    clamp(1 + WB_PULL * (want / have - 1), LIMITS.tint.lo, LIMITS.tint.hi);

  return {
    linear: { multiplier: Number(multiplier.toFixed(4)), offset: Number(offset.toFixed(2)) },
    modulate: { brightness: 1, saturation: Number(saturation.toFixed(4)) },
    tint: {
      red: Number(toward(ref.rg, p.rg).toFixed(4)),
      blue: Number(toward(ref.bg, p.bg).toFixed(4)),
    },
    sharpenSigma: 0,
  };
}
