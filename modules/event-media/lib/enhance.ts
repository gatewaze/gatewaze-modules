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
  'Answer with JSON only, no prose, no code fence, in exactly this shape:',
  '{"needs":true,"exposure":0,"contrast":0,"warmth":0,"saturation":0,"sharpen":0,"note":"one short sentence"}',
  'Each number is between -100 and 100 (sharpen between 0 and 100), where 0 means leave it alone.',
  'Positive exposure brightens, positive contrast adds punch, positive warmth is warmer,',
  'positive saturation is more colourful. Be conservative: these are real photographs of real',
  'people and the result must still look like the photograph that was taken.',
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
 * The strongest thing the model can ask for is about a third of a stop
 * of exposure, a fifth more contrast, a gentle warm or cool shift, a
 * fifth more colour and a light unsharp mask. Asked for more, it gets
 * this. Nobody looking at the result should be able to say what was
 * done to it -- only that it looks like the evening did.
 */
export function opsFor(v: EnhanceVerdict): EnhanceOps {
  // Contrast pivots around mid grey: out = (in - 128) * m + 128 + e.
  const multiplier = 1 + (v.contrast / 100) * 0.20;
  const exposureOffset = (v.exposure / 100) * 28;
  const offset = 128 - 128 * multiplier + exposureOffset;
  return {
    linear: { multiplier: Number(multiplier.toFixed(4)), offset: Number(offset.toFixed(2)) },
    modulate: {
      // Brightness is left to the linear offset above; modulate carries
      // the colour. Both at once double-counts and blows highlights.
      brightness: 1,
      saturation: Number((1 + (v.saturation / 100) * 0.20).toFixed(4)),
    },
    tint: {
      red: Number((1 + (v.warmth / 100) * 0.06).toFixed(4)),
      blue: Number((1 - (v.warmth / 100) * 0.06).toFixed(4)),
    },
    // A photograph that is genuinely soft cannot be rescued by
    // sharpening, and an over-sharpened face looks worse than a soft
    // one, so this stays gentle.
    sharpenSigma: v.sharpen >= WORTH_DOING ? Number((0.5 + (v.sharpen / 100) * 1.0).toFixed(2)) : 0,
  };
}
