/**
 * Giving every photograph the same finish.
 *
 * lib/enhance.ts corrects a photograph against itself: it is too dark, so
 * lift it; the lift raised the blacks, so put them back. That makes each
 * photograph better and does nothing at all for consistency -- an album
 * of two hundred photographs corrected one at a time still looks like
 * two hundred photographs.
 *
 * This is the other half: measure a photograph, and carry it towards a
 * reference taken from a real photographer's published work.
 *
 * It began as seven numbers -- brightness, contrast, saturation, colour
 * balance -- which turned out to be a thin description of a look.
 * Measured on 2026-09-29 against the wedding photographer's portfolio,
 * four things those seven could not see:
 *
 *     his corners are 19% darker than his centres and the guests' are
 *     slightly brighter (0.807 against 1.056), and nothing was touching
 *     it at all
 *
 *     his shadows are near neutral and theirs are strongly red (warmth
 *     1.14 against 1.51) -- candlelight pooling in the darks, which one
 *     global white balance cannot reach
 *
 *     his tone curve has a deeper toe: first decile at 19 against their
 *     28, and a three-point match was pushing it the wrong way, to 32
 *
 *     stretching contrast on noisy phone files ADDS grain -- his 5.70
 *     against their 8.24, and the graded copies came out at 9.35
 *
 * So a profile is now around thirty numbers: a nine-point tone curve,
 * the colour and saturation of the shadows and the highlights
 * separately, vignetting, grain, depth of field, and how much of the
 * photographer's work is black and white.
 *
 * Still pure arithmetic. Nothing is drawn, and every pixel that comes
 * out is a function of one that was already there.
 */

/** How many points describe the tone curve. */
export const CURVE_POINTS = 9;

/** What a photograph, or a body of work, measures. */
export interface ToneProfile {
  /** Average brightness, 0..255. */
  mean: number;
  /** Brightness at each decile, 10% through 90%. */
  curve: number[];
  /** The same measurement at three familiar points. */
  p5: number;
  p50: number;
  p95: number;
  /** Mean HSV saturation over pixels with light in them, 0..1. */
  sat: number;
  /** Colour balance over the whole frame, as ratios to green. */
  rg: number;
  bg: number;
  /** Red over blue in the darkest fifth, and in the brightest fifth. */
  shadowWarm: number;
  highWarm: number;
  /** Saturation in those same two bands. */
  shadowSat: number;
  highSat: number;
  /** Corner brightness over centre brightness. Below 1 is a vignette. */
  vignette: number;
  /** How much high-frequency detail there is: noise, or grain. */
  grain: number;
  /** Sharpness in the middle over sharpness at the edges. */
  dof: number;
  /** How much of this body of work is black and white, 0..1. */
  monoShare: number;
}

/**
 * The look every photograph is carried towards.
 *
 * Measured over 93 photographs by the wedding's own photographer -- 13
 * panels from what he delivered and 80 from his published portfolio --
 * with the richer measurements taken from the 80.
 */
export const HOUSE: ToneProfile = {
  mean: 100.7,
  curve: [19, 26, 45, 70, 93, 117, 137, 161, 186],
  p5: 15.7, p50: 92.7, p95: 204.7,
  sat: 0.273, rg: 1.079, bg: 0.926,
  shadowWarm: 1.14, highWarm: 1.05,
  shadowSat: 0.30, highSat: 0.22,
  vignette: 0.807, grain: 5.70, dof: 1.74,
  monoShare: 0.31,
};

/**
 * How far towards the reference a photograph is carried.
 *
 * Tone least: a photograph was taken in the room it was taken in.
 * Colour hardest: a cast is a fault rather than a mood.
 */
const PULL = { tone: 0.7, sat: 0.8, colour: 0.8, split: 0.7, vignette: 0.8 };

/** What a grade may do, so that it stays a grade. */
const LIMITS = {
  curve: 42,
  saturation: { lo: 0.45, hi: 1.3 },
  tint: { lo: 0.85, hi: 1.2 },
  split: { lo: 0.88, hi: 1.14 },
  vignette: { lo: 0.6, hi: 1.0 },
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const safe = (v: number) => (Number.isFinite(v) && v > 0.5 ? v : 1);

/** Everything needed to put one photograph through the reference. */
export interface Grade {
  /** 256-entry tone map, applied to every channel. */
  lut: Uint8ClampedArray;
  /** Overall colour, as gains on red and blue. */
  tint: { red: number; blue: number };
  /** More or less warmth at each end of the range. */
  split: { shadow: number; highlight: number };
  /** Pull towards each pixel's own brightness. */
  saturation: number;
  /** How far the corners come down, 1 being not at all. */
  vignette: number;
}

/** Measure a photograph. Width and height unlock vignette and grain. */
export function profileOf(data: Uint8ClampedArray, width = 0, height = 0): ToneProfile {
  if (data.length < 16) return { ...HOUSE, monoShare: 0 };
  const bins = new Uint32Array(256);
  let n = 0, total = 0, r = 0, g = 0, b = 0, sat = 0, satN = 0;
  for (let i = 0; i < data.length; i += 32) {
    const R = data[i]!, G = data[i + 1]!, B = data[i + 2]!;
    const luma = 0.299 * R + 0.587 * G + 0.114 * B;
    bins[Math.max(0, Math.min(255, Math.round(luma)))]! += 1;
    total += luma;
    r += R; g += G; b += B;
    const mx = Math.max(R, G, B);
    if (mx > 20) { sat += (mx - Math.min(R, G, B)) / mx; satN += 1; }
    n += 1;
  }
  if (n === 0) return { ...HOUSE, monoShare: 0 };

  const at = (q: number): number => {
    const want = n * q;
    let seen = 0;
    for (let v = 0; v < 256; v += 1) {
      seen += bins[v]!;
      if (seen >= want) return v;
    }
    return 255;
  };
  const curve: number[] = [];
  for (let i = 1; i <= CURVE_POINTS; i += 1) curve.push(at(i / (CURVE_POINTS + 1)));

  // The colour of the two ends, separately: one white balance cannot
  // reach a cast that lives only in the shadows.
  //
  // A flat photograph has no two ends -- its 20th and 80th percentiles
  // land on the same value, the bands come out empty, and anything
  // invented to fill them is a correction aimed at nothing. So the
  // fallback is the frame's own red-over-blue, which makes the split a
  // no-op rather than a guess.
  const lo = at(0.2), hi = at(0.8);
  const overallRB = safe(r / n) / safe(b / n);
  const ENOUGH = 8;
  let sr = 0, sb = 0, sn = 0, ss = 0;
  let hr = 0, hb = 0, hn = 0, hs = 0;
  for (let i = 0; i < data.length; i += 32) {
    const R = data[i]!, G = data[i + 1]!, B = data[i + 2]!;
    const luma = 0.299 * R + 0.587 * G + 0.114 * B;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    const s = mx > 20 ? (mx - mn) / mx : 0;
    if (luma <= lo) { sr += R; sb += B; ss += s; sn += 1; }
    else if (luma >= hi) { hr += R; hb += B; hs += s; hn += 1; }
  }

  // Vignetting, grain and focus need the shape of the frame. Without it
  // they read as "no opinion" rather than being guessed at.
  let vignette = 1, grain = HOUSE.grain, dof = 1;
  if (width > 8 && height > 8 && data.length >= width * height * 4) {
    const lumaAt = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      return 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    };
    const band = Math.max(4, Math.floor(Math.min(width, height) / 8));
    const cx = Math.floor(width / 2), cy = Math.floor(height / 2);
    const rad = Math.max(4, Math.floor(Math.min(width, height) / 6));
    let cTotal = 0, cN = 0;
    for (let y = Math.max(0, cy - rad); y < Math.min(height, cy + rad); y += 2) {
      for (let x = Math.max(0, cx - rad); x < Math.min(width, cx + rad); x += 2) {
        cTotal += lumaAt(x, y); cN += 1;
      }
    }
    let kTotal = 0, kN = 0;
    for (const [ox, oy] of [[0, 0], [width - band, 0], [0, height - band], [width - band, height - band]]) {
      for (let y = oy!; y < oy! + band; y += 2) {
        for (let x = ox!; x < ox! + band; x += 2) { kTotal += lumaAt(x, y); kN += 1; }
      }
    }
    if (cN > 0 && kN > 0) vignette = (kTotal / kN) / ((cTotal / cN) + 1e-6);

    let midE = 0, midN = 0, edgeE = 0, edgeN = 0, allE = 0, allN = 0;
    for (let y = 1; y < height - 1; y += 3) {
      for (let x = 1; x < width - 1; x += 3) {
        const d = Math.abs(4 * lumaAt(x, y) - lumaAt(x - 1, y) - lumaAt(x + 1, y)
          - lumaAt(x, y - 1) - lumaAt(x, y + 1));
        allE += d * d; allN += 1;
        const middle = x > width / 4 && x < (3 * width) / 4 && y > height / 4 && y < (3 * height) / 4;
        if (middle) { midE += d * d; midN += 1; } else { edgeE += d * d; edgeN += 1; }
      }
    }
    if (allN > 0) grain = Math.sqrt(allE / allN) / 4;
    if (midN > 0 && edgeN > 0) dof = (midE / midN) / ((edgeE / edgeN) + 1e-6);
  }

  return {
    mean: total / n,
    curve,
    p5: at(0.05), p50: at(0.5), p95: at(0.95),
    sat: satN > 0 ? sat / satN : HOUSE.sat,
    rg: safe(r / n) / safe(g / n),
    bg: safe(b / n) / safe(g / n),
    shadowWarm: sn >= ENOUGH ? safe(sr / sn) / safe(sb / sn) : overallRB,
    highWarm: hn >= ENOUGH ? safe(hr / hn) / safe(hb / hn) : overallRB,
    shadowSat: sn >= ENOUGH ? ss / sn : (satN > 0 ? sat / satN : HOUSE.shadowSat),
    highSat: hn >= ENOUGH ? hs / hn : (satN > 0 ? sat / satN : HOUSE.highSat),
    vignette, grain, dof,
    monoShare: 0,
  };
}

/**
 * The adjustments that carry one photograph towards the reference.
 *
 * The tone curve is matched point by point rather than end to end, so
 * the shape of the toe and the shoulder carry over and not only the
 * black and white points. Colour is corrected once globally and then
 * again at each end separately. Vignetting is matched as a ratio.
 */
export function gradeFor(p: ToneProfile, ref: ToneProfile = HOUSE): Grade {
  const from: number[] = [0];
  const to: number[] = [0];
  for (let i = 0; i < CURVE_POINTS; i += 1) {
    const have = p.curve[i] ?? ((i + 1) * 255) / (CURVE_POINTS + 1);
    const want = ref.curve[i] ?? have;
    const moved = have + (want - have) * PULL.tone;
    from.push(have);
    to.push(clamp(moved, have - LIMITS.curve, have + LIMITS.curve));
  }
  from.push(255); to.push(255);
  // Monotonic, so the curve can never fold back on itself.
  for (let i = 1; i < to.length; i += 1) to[i] = Math.max(to[i]!, to[i - 1]! + 0.5);

  const lut = new Uint8ClampedArray(256);
  let seg = 0;
  for (let v = 0; v < 256; v += 1) {
    while (seg < from.length - 2 && v > from[seg + 1]!) seg += 1;
    const x0 = from[seg]!, x1 = from[seg + 1]!;
    const y0 = to[seg]!, y1 = to[seg + 1]!;
    const t = x1 > x0 ? (v - x0) / (x1 - x0) : 0;
    lut[v] = Math.round(y0 + (y1 - y0) * clamp(t, 0, 1));
  }

  const toward = (want: number, have: number, pull: number, lim: { lo: number; hi: number }) =>
    Number(clamp(1 + pull * (safe(want) / safe(have) - 1), lim.lo, lim.hi).toFixed(4));

  const wantSat = p.sat + (ref.sat - p.sat) * PULL.sat;
  const saturation = p.sat > 0.01
    ? Number(clamp(wantSat / p.sat, LIMITS.saturation.lo, LIMITS.saturation.hi).toFixed(4))
    : 1;

  return {
    lut,
    tint: {
      red: toward(ref.rg, p.rg, PULL.colour, LIMITS.tint),
      blue: toward(ref.bg, p.bg, PULL.colour, LIMITS.tint),
    },
    split: {
      shadow: toward(ref.shadowWarm, p.shadowWarm, PULL.split, LIMITS.split),
      highlight: toward(ref.highWarm, p.highWarm, PULL.split, LIMITS.split),
    },
    saturation,
    vignette: Number(clamp(
      1 + PULL.vignette * (ref.vignette - p.vignette),
      LIMITS.vignette.lo, LIMITS.vignette.hi,
    ).toFixed(4)),
  };
}

/**
 * Put a photograph through a grade, in place.
 *
 * One pass: the tone curve, the overall tint, a little more or less
 * warmth at whichever end of the range the pixel belongs to, the colour
 * pull, and then the corners brought down.
 */
export function applyGrade(data: Uint8ClampedArray, width: number, height: number, g: Grade): void {
  const { lut, tint, split, saturation, vignette } = g;
  const w = Math.max(1, width);
  const cx = (w - 1) / 2, cy = (Math.max(1, height) - 1) / 2;
  const maxR = Math.sqrt(cx * cx + cy * cy) || 1;
  const hasVignette = Math.abs(vignette - 1) > 0.002;

  for (let i = 0, px = 0; i < data.length; i += 4, px += 1) {
    let r = lut[data[i]!]!;
    let gg = lut[data[i + 1]!]!;
    let b = lut[data[i + 2]!]!;

    r *= tint.red;
    b *= tint.blue;

    // Which end this pixel belongs to, as a weight, so the split is a
    // gradient rather than a pair of thresholds.
    const luma = 0.299 * r + 0.587 * gg + 0.114 * b;
    const dark = clamp(1 - luma / 110, 0, 1);
    const light = clamp((luma - 145) / 110, 0, 1);
    if (dark > 0 && split.shadow !== 1) {
      const k = 1 + (split.shadow - 1) * dark;
      r *= k; b /= k;
    }
    if (light > 0 && split.highlight !== 1) {
      const k = 1 + (split.highlight - 1) * light;
      r *= k; b /= k;
    }

    if (saturation !== 1) {
      const l = 0.299 * r + 0.587 * gg + 0.114 * b;
      r = l + (r - l) * saturation;
      gg = l + (gg - l) * saturation;
      b = l + (b - l) * saturation;
    }

    if (hasVignette) {
      const x = px % w, y = (px - x) / w;
      const dx = x - cx, dy = y - cy;
      const t = Math.sqrt(dx * dx + dy * dy) / maxR;
      const k = 1 - (1 - vignette) * t * t;
      r *= k; gg *= k; b *= k;
    }

    data[i] = r; data[i + 1] = gg; data[i + 2] = b;
  }
}

/** Every pixel to its own brightness: the black-and-white treatment. */
export function applyMono(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    data[i] = l; data[i + 1] = l; data[i + 2] = l;
  }
}
