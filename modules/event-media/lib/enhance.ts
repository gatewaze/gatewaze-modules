/**
 * Making a photograph better without making it a different photograph.
 *
 * Some of the day's photographs are dark, flat or a little soft --
 * phones in a marquee at nine in the evening. An organiser can turn
 * enhancement on for an album and have those improved (asked
 * 2026-09-27), with two rules that decide everything here:
 *
 *   it is an enhance, not a regeneration. Nothing is drawn. A model
 *   looks at the photograph and says what it needs; the change itself is
 *   arithmetic on the pixels -- exposure, contrast, warmth, saturation,
 *   sharpening -- so a face cannot come back as somebody else's face,
 *   and nothing can appear that was not there.
 *
 *   the original is never touched. The enhanced copy is written beside
 *   it and shown only where an organiser asked for it.
 *
 * This file is the part with no I/O in it: the prompt, reading the
 * model's answer, and turning that answer into bounded adjustments. The
 * bounds are the important half -- a model that asks for the exposure to
 * be doubled gets what we are prepared to give it, not what it asked
 * for.
 */

/** What the model is asked to return. */
export interface EnhanceVerdict {
  /** Worth doing at all. A photograph that is fine is left alone. */
  needs: boolean;
  /** Stops down or opens up: -100 (much darker) .. 100 (much brighter). */
  exposure: number;
  /** Flat to punchy: -100 .. 100. */
  contrast: number;
  /** Cool to warm: -100 (bluer) .. 100 (warmer). */
  warmth: number;
  /** Washed out to vivid: -100 .. 100. */
  saturation: number;
  /** Soft to crisp: 0 (leave it) .. 100. */
  sharpen: number;
  /** What it saw, for an organiser reading the record later. */
  note: string;
}

/** What sharp is actually asked to do. */
export interface EnhanceOps {
  /** Multiply and offset the pixel values: contrast and exposure. */
  linear: { multiplier: number; offset: number };
  /** modulate(): overall lightness and colour strength. */
  modulate: { brightness: number; saturation: number };
  /** Warmth as a per-channel gain on red and blue. */
  tint: { red: number; blue: number };
  /** Unsharp mask radius; 0 means do not sharpen. */
  sharpenSigma: number;
}

/**
 * The question, written so the answer is usable.
 *
 * It asks for judgement about the photograph as a photograph -- was
 * there enough light, is it flat, is it soft -- and forbids anything
 * about its content, because nothing here can act on content anyway.
 */
export const ENHANCE_PROMPT = [
  'You are a photo editor preparing wedding photographs for printing.',
  'Look at this photograph and say what it needs to look its best.',
  'Judge only the exposure, contrast, colour temperature, colour strength and sharpness.',
  'Do not comment on the people, the composition or the subject.',
  'A photograph that is already good needs nothing: say so rather than inventing work.',
  'Many of these were taken in a dark room, and a photograph that is genuinely dark needs',
  'real light -- say so plainly rather than asking for a token amount that will not be seen.',
  'Answer with JSON only, no prose, no code fence, in exactly this shape:',
  '{"needs":true,"exposure":0,"contrast":0,"warmth":0,"saturation":0,"sharpen":0,"note":"one short sentence"}',
  'Each number is between -100 and 100 (sharpen between 0 and 100), where 0 means leave it alone.',
  'Use the whole scale. 10 is a nudge nobody will see and is almost never the right answer;',
  '40 is a clear correction; 80 rescues a badly underexposed photograph. If the room was dark',
  'and the faces are muddy, the exposure you want is 50 to 80, not 5.',
  'Positive exposure brightens, positive contrast adds punch, positive warmth is warmer,',
  'positive saturation is more colourful. Ask for what the photograph actually needs: too',
  'timid is as wrong as too much. The result must still look like the photograph that was',
  'taken -- these are real people -- but it should look like it on a good day.',
].join(' ');

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function num(value: unknown, lo: number, hi: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? clamp(n, lo, hi) : 0;
}

/**
 * Read the model's answer. Anything unparseable is "no opinion", which
 * means the photograph is left exactly as it is.
 */
export function parseVerdict(text: string): EnhanceVerdict | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 4000) return null;
  // Models like to wrap JSON in a fence or a sentence.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const note = typeof r['note'] === 'string' ? r['note'].replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const verdict: EnhanceVerdict = {
    needs: r['needs'] !== false,
    exposure: num(r['exposure'], -100, 100),
    contrast: num(r['contrast'], -100, 100),
    warmth: num(r['warmth'], -100, 100),
    saturation: num(r['saturation'], -100, 100),
    sharpen: num(r['sharpen'], 0, 100),
    note,
  };
  return verdict;
}

/**
 * Below this, a photograph is left alone: the model said it needed
 * something, but not enough of anything to be worth rewriting the file
 * and asking a phone to download it again.
 */
const WORTH_DOING = 4;

export function worthEnhancing(v: EnhanceVerdict): boolean {
  if (!v.needs) return false;
  return Math.abs(v.exposure) >= WORTH_DOING
    || Math.abs(v.contrast) >= WORTH_DOING
    || Math.abs(v.warmth) >= WORTH_DOING
    || Math.abs(v.saturation) >= WORTH_DOING
    || v.sharpen >= WORTH_DOING;
}

/**
 * The verdict as things sharp can do, with the ceilings that keep this
 * an enhancement.
 *
 * The strongest thing the model can ask for is about two thirds of a
 * stop of exposure, a third more contrast, a gentle warm or cool shift,
 * a quarter more colour and a light unsharp mask. Asked for more, it
 * gets this.
 *
 * These were a third of a stop and a fifth of contrast, which turned out
 * to be invisible: the photo booth's room was very dark, and an
 * adjustment nobody can see is not worth making or paying for (reported
 * 2026-09-28). The ceilings are what keep this an enhancement, so they
 * are still here -- a photograph is lifted, not relit, and nobody should
 * be able to say what was done to it beyond "that came out well".
 */
export function opsFor(v: EnhanceVerdict): EnhanceOps {
  // Contrast pivots around mid grey: out = (in - 128) * m + 128 + e.
  const multiplier = 1 + (v.contrast / 100) * 0.30;
  const exposureOffset = (v.exposure / 100) * 55;
  const offset = 128 - 128 * multiplier + exposureOffset;
  return {
    linear: { multiplier: Number(multiplier.toFixed(4)), offset: Number(offset.toFixed(2)) },
    modulate: {
      // Brightness is left to the linear offset above; modulate carries
      // the colour. Both at once double-counts and blows highlights.
      brightness: 1,
      saturation: Number((1 + (v.saturation / 100) * 0.25).toFixed(4)),
    },
    tint: {
      red: Number((1 + (v.warmth / 100) * 0.06).toFixed(4)),
      blue: Number((1 - (v.warmth / 100) * 0.06).toFixed(4)),
    },
    // A photograph that is genuinely soft cannot be rescued by
    // sharpening, and an over-sharpened face looks worse than a soft
    // one, so this stays gentle.
    sharpenSigma: v.sharpen >= WORTH_DOING ? Number((0.6 + (v.sharpen / 100) * 1.4).toFixed(2)) : 0,
  };
}

/**
 * The adjustments, applied to real pixels.
 *
 * In place, over RGBA as a canvas hands it out. Deliberately the whole of
 * the image work: a gain and an offset (contrast and exposure), a gain on
 * red and blue (warmth), a pull towards or away from the pixel's own
 * brightness (colour), and an unsharp mask. Every one of them is a sum of
 * numbers that were already in the photograph. Nothing is invented, which
 * is what makes this an enhancement rather than a regeneration.
 *
 * Runs in the organiser's browser. It used to run on the server, which
 * cost the site two outages: an api pod with 512MB cannot decode a
 * twelve-megapixel photograph while it is also serving a wedding.
 */
export function applyOps(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  ops: EnhanceOps,
): void {
  const { multiplier: m, offset: b } = ops.linear;
  const sat = ops.modulate.saturation;
  const { red, blue } = ops.tint;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i]! * m * red + b;
    let g = data[i + 1]! * m + b;
    let bl = data[i + 2]! * m * blue + b;
    if (sat !== 1) {
      // Rec. 601 luma: the brightness the eye reads, so pulling colour
      // towards or away from it does not change how light a pixel looks.
      const luma = 0.299 * r + 0.587 * g + 0.114 * bl;
      r = luma + (r - luma) * sat;
      g = luma + (g - luma) * sat;
      bl = luma + (bl - luma) * sat;
    }
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = bl;
  }

  if (ops.sharpenSigma > 0) unsharp(data, width, height, ops.sharpenSigma);
}

/**
 * An unsharp mask: the picture, plus a fraction of what a slight blur
 * leaves out. Gentle by construction -- sigma is capped at 1.5 by
 * opsFor, and an over-sharpened face looks worse than a soft one.
 */
function unsharp(data: Uint8ClampedArray, width: number, height: number, sigma: number): void {
  const amount = Math.min(1, sigma / 2) * 0.8;
  if (amount <= 0 || width < 3 || height < 3) return;
  // A copy to read from, so each pixel sees its neighbours as they were.
  const src = new Uint8ClampedArray(data);
  const at = (x: number, y: number, c: number) => src[(y * width + x) * 4 + c]!;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        // A 3x3 box blur is enough: the radius is a pixel either way.
        const blur = (
          at(x - 1, y - 1, c) + at(x, y - 1, c) + at(x + 1, y - 1, c)
          + at(x - 1, y, c) + at(x, y, c) + at(x + 1, y, c)
          + at(x - 1, y + 1, c) + at(x, y + 1, c) + at(x + 1, y + 1, c)
        ) / 9;
        data[o + c] = src[o + c]! + (src[o + c]! - blur) * amount;
      }
    }
  }
}

/**
 * How dark a photograph is, as the average brightness of its pixels.
 * 0 is black, 255 is white; a well-lit photograph of people sits around
 * 110-140 and the booth's room came out nearer 50.
 */
export function meanLuma(data: Uint8ClampedArray): number {
  if (data.length < 4) return 128;
  let total = 0;
  let n = 0;
  // Every eighth pixel is plenty for an average and eight times quicker.
  for (let i = 0; i < data.length; i += 32) {
    total += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    n += 1;
  }
  return n > 0 ? total / n : 128;
}

/** Roughly where a well-lit photograph of people sits. */
const TARGET_LUMA = 118;
/** Above this a photograph of people reads as washed out. */
const CEILING_LUMA = 145;
/** The most this backstop will move the exposure, in levels out of 255. */
const MAX_LIFT = 55;
/**
 * How much of the way to the target a dark photograph is carried.
 *
 * Not all of it, deliberately. A candlelit room is meant to look like a
 * candlelit room, and pulling every photograph onto the same number is
 * not enhancement, it is flattening -- measured on the wedding on
 * 2026-09-29, twelve enhanced evening photographs all landed between
 * 119 and 122 while the untouched albums ranged from 78 to 135. The
 * photographs stopped differing from each other.
 */
const PULL = 0.6;

/**
 * Where the linear op will leave the average brightness.
 *
 * `applyOps` computes `in * m + offset`, and `opsFor` builds that offset
 * as `128 - 128 * m + e` so the contrast multiplier pivots around mid
 * grey. So the exposure the model actually asked for is `e`, and the
 * photograph lands at `(mean - 128) * m + 128 + e`.
 */
function landsAt(mean: number, multiplier: number, exposure: number): number {
  return (mean - 128) * multiplier + 128 + exposure;
}

/**
 * The exposure a photograph should end up with, measured from its pixels.
 *
 * The model is a good judge of what KIND of correction a photograph
 * wants and a poor judge of how much: asked about photographs taken in a
 * very dark room it kept answering "a touch of sharpening", which is
 * invisible and not worth paying for (reported 2026-09-28). The pixels
 * are not a matter of opinion, so this adjusts the model's answer
 * towards what the photograph measures.
 *
 * It works in exposure units, on top of the contrast pivot -- the
 * version before this returned a whole `offset` and so threw the
 * `128 - 128 * m` pivot term away, turning `(in - 128) * m + 128 + e`
 * into `in * m + 55`. That lifts black to 55 and is what made the
 * enhanced copies look milky (reported 2026-09-29).
 */
export function exposureFor(mean: number, multiplier: number, asked: number): number {
  if (!Number.isFinite(mean) || !Number.isFinite(multiplier)) return asked;
  const at = landsAt(mean, multiplier, asked);
  // Part of the way up for a dark photograph, all of the way down for one
  // that would come out washed out: too bright is a fault, too moody is a
  // choice.
  const wanted = at < TARGET_LUMA ? asked + (TARGET_LUMA - at) * PULL
    : at > CEILING_LUMA ? asked - (at - CEILING_LUMA)
    : asked;
  return Number(Math.max(-MAX_LIFT, Math.min(MAX_LIFT, wanted)).toFixed(2));
}

/**
 * How dark this photograph's shadows are: roughly its fifth percentile.
 *
 * Sampled the same way as `meanLuma`, through a 256-bin histogram, so it
 * costs one more pass over every eighth pixel and no sorting.
 */
export function darkPoint(data: Uint8ClampedArray): number {
  if (data.length < 4) return 0;
  const bins = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < data.length; i += 32) {
    const luma = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    bins[Math.max(0, Math.min(255, Math.round(luma)))]! += 1;
    n += 1;
  }
  if (n === 0) return 0;
  const want = n * 0.05;
  let seen = 0;
  for (let v = 0; v < 256; v += 1) {
    seen += bins[v]!;
    if (seen >= want) return v;
  }
  return 0;
}

/** The most the shadows may rise, in levels out of 255. */
const DARK_DRIFT = 12;
/** The contrast ceiling, matching the strongest answer `opsFor` can build. */
const MAX_MULTIPLIER = 1.30;

/**
 * The contrast needed to put the shadows back after an exposure lift.
 *
 * Lifting exposure is adding a constant, so it moves black as far as it
 * moves everything else: a photograph whose shadows sat at 8 comes out
 * with them at 38, which is not black any more, and the copy looks
 * milky. Contrast pivots around mid grey, so raising it pulls the
 * shadows back down while leaving the mid tones where the exposure
 * correction put them.
 *
 * Measured on the wedding's dark photographs on 2026-09-29: at the
 * contrast the model asked for, black landed at 38-46; solving for it
 * brings it back to the mid twenties against an original 8-13.
 *
 * Only ever raises the model's answer, and only when something was
 * actually lifted -- a photograph that needed no exposure keeps the
 * contrast it was given.
 */
export function multiplierFor(dark: number, exposure: number, asked: number): number {
  if (!Number.isFinite(dark) || exposure <= 0) return asked;
  // No shadows to protect: everything here is above mid grey anyway.
  if (dark >= 128) return asked;
  // Solve dark * m + (128 - 128m) + exposure = dark + DARK_DRIFT for m.
  const needed = (dark + DARK_DRIFT - 128 - exposure) / (dark - 128);
  return Number(Math.max(asked, Math.min(MAX_MULTIPLIER, needed)).toFixed(4));
}

/**
 * The model's ops, with the tone corrected against the real pixels.
 *
 * The pivot arithmetic lives here and nowhere else, so a caller cannot
 * pull the offset apart wrongly -- which is how the milky copies of
 * 2026-09-29 happened.
 *
 * Exposure is settled twice because the two corrections are coupled:
 * raising the multiplier to protect the shadows also darkens the mid
 * tones, so the exposure that was right against the model's contrast is
 * a little short against the corrected one.
 */
export function withMeasuredTone(ops: EnhanceOps, mean: number, dark: number): EnhanceOps {
  const asked = ops.linear.offset - (128 - 128 * ops.linear.multiplier);
  const first = exposureFor(mean, ops.linear.multiplier, asked);
  const m = multiplierFor(dark, first, ops.linear.multiplier);
  const exposure = exposureFor(mean, m, asked);
  return {
    ...ops,
    linear: {
      multiplier: m,
      offset: Number((128 - 128 * m + exposure).toFixed(2)),
    },
  };
}

/** The average of each colour channel, for judging a cast. */
export interface ChannelMeans { r: number; g: number; b: number }

/** Where each channel sits on average. Sampled as `meanLuma` samples. */
export function channelMeans(data: Uint8ClampedArray): ChannelMeans {
  if (data.length < 4) return { r: 128, g: 128, b: 128 };
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 32) {
    r += data[i]!;
    g += data[i + 1]!;
    b += data[i + 2]!;
    n += 1;
  }
  return n > 0 ? { r: r / n, g: g / n, b: b / n } : { r: 128, g: 128, b: 128 };
}

/**
 * How far back towards the original's colour a generated copy is pulled.
 * Not all of the way: the model is entitled to change the light, and
 * some of the warmth it adds belongs to the relighting rather than to
 * the cast.
 */
const WHITE_BALANCE_PULL = 0.8;
/** The most this will scale a channel, either way. */
const TINT_LIMIT = { lo: 0.75, hi: 1.35 };

/**
 * The tint that puts a generated copy back on the original's colour.
 *
 * ControlLight warms every photograph it touches: measured over the
 * wedding's night-before album on 2026-09-29, red rose against green on
 * all seven, by 0.035 to 0.162, and the copies read as too warm
 * (reported the same day). The drift is not the same on each, so a fixed
 * cooling tint would overcorrect some and miss others.
 *
 * Ratios to green are used rather than absolute channel means, so a
 * photograph the model legitimately brightened is not dragged back down:
 * this moves the COLOUR towards the original and leaves the light alone.
 */
export function neutraliseFor(original: ChannelMeans, copy: ChannelMeans): { red: number; blue: number } {
  const safe = (v: number) => (Number.isFinite(v) && v > 0.5 ? v : 1);
  const oRed = safe(original.r) / safe(original.g);
  const oBlue = safe(original.b) / safe(original.g);
  const cRed = safe(copy.r) / safe(copy.g);
  const cBlue = safe(copy.b) / safe(copy.g);
  const pull = (want: number, have: number) => {
    const full = want / have;
    const part = 1 + WHITE_BALANCE_PULL * (full - 1);
    return Number(Math.max(TINT_LIMIT.lo, Math.min(TINT_LIMIT.hi, part)).toFixed(4));
  };
  return { red: pull(oRed, cRed), blue: pull(oBlue, cBlue) };
}

/** Those gains as something `applyOps` can run: colour only, no light. */
export function neutraliseOps(original: ChannelMeans, copy: ChannelMeans): EnhanceOps {
  const tint = neutraliseFor(original, copy);
  return {
    linear: { multiplier: 1, offset: 0 },
    modulate: { brightness: 1, saturation: 1 },
    tint,
    sharpenSigma: 0,
  };
}
