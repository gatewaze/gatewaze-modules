/**
 * Style helpers (spec §8): map the inferred `vehicle_character` to a style-
 * template skill id, merge inferred + operator-overridden knobs, and provide the
 * neutral default profile used when the style recipe fails (§11 STYLE_RECIPE_FAILED).
 */

export type VehicleCharacter = 'heritage' | 'performance' | 'executive' | 'family' | 'rugged' | 'eco';

export const VEHICLE_CHARACTERS: VehicleCharacter[] = [
  'heritage',
  'performance',
  'executive',
  'family',
  'rugged',
  'eco',
];

export interface StyleKnobs {
  pacing: 'classic_slow' | 'balanced' | 'edgy_fast';
  camera_energy: 'gentle' | 'moderate' | 'dynamic';
  tone: 'refined' | 'warm' | 'confident' | 'energetic' | 'rugged';
  /** A prebuilt Gemini TTS voice name. */
  voice: string;
  /** Natural-language TTS delivery instruction (regional accent + tone) matching the seller's location. */
  accent?: string;
}

export interface Audience {
  summary: string;
  buyer_motivations: string[];
  market_read?: string;
  lifestyle?: string;
  age_lean?: string;
  notes?: string;
}

export interface StyleProfile {
  vehicle_character: VehicleCharacter;
  audience: Audience;
  style: StyleKnobs;
  rationale?: string;
}

/** vehicle_character → the style-template skill id in danthebaker/agents. */
export function templateSkillId(character: VehicleCharacter): string {
  return `vehicle-video-style-${character}`;
}

/** Coerce an arbitrary/nullable character to a valid one (default: executive). */
export function coerceCharacter(v: unknown): VehicleCharacter {
  return VEHICLE_CHARACTERS.includes(v as VehicleCharacter) ? (v as VehicleCharacter) : 'executive';
}

// Allowed values for the operator-adjustable style knobs. Anything else in an
// override is ignored (keeps the inferred value) — these flow into the Gemini
// prompt, so unvalidated free-text must not pass through. `voice` is re-checked
// against KNOWN_VOICES at TTS time; `accent` is natural-language delivery
// guidance so it can't be an enum, but it's length-capped to stay a knob.
const PACINGS: StyleKnobs['pacing'][] = ['classic_slow', 'balanced', 'edgy_fast'];
const CAMERA_ENERGIES: StyleKnobs['camera_energy'][] = ['gentle', 'moderate', 'dynamic'];
const TONES: StyleKnobs['tone'][] = ['refined', 'warm', 'confident', 'energetic', 'rugged'];
const ACCENT_MAX = 200;

/** Merge operator-supplied knob overrides onto the base, keeping only valid enum values. */
function mergeKnobs(base: StyleKnobs, override?: Partial<StyleKnobs> | null): StyleKnobs {
  if (!override) return base;
  const pick = <T>(allowed: T[], v: unknown, fallback: T): T =>
    allowed.includes(v as T) ? (v as T) : fallback;
  return {
    pacing: pick(PACINGS, override.pacing, base.pacing),
    camera_energy: pick(CAMERA_ENERGIES, override.camera_energy, base.camera_energy),
    tone: pick(TONES, override.tone, base.tone),
    voice: typeof override.voice === 'string' && override.voice ? override.voice : base.voice,
    accent:
      typeof override.accent === 'string' ? override.accent.slice(0, ACCENT_MAX) : base.accent,
  };
}

/** Neutral default profile — used when inference fails so a run is never hard-blocked (§11). */
export function neutralDefaultProfile(): StyleProfile {
  return {
    vehicle_character: 'executive',
    audience: {
      summary: 'A broad audience of practical buyers.',
      buyer_motivations: ['value', 'reliability'],
    },
    style: { pacing: 'balanced', camera_energy: 'moderate', tone: 'confident', voice: 'Charon', accent: 'a clear, natural British accent' },
    rationale: 'Neutral default (style inference unavailable).',
  };
}

/**
 * Merge operator overrides onto an inferred profile. Overrides win over the
 * inference; unset fields keep the inferred value. Also re-coerces the character.
 */
export function mergeOverrides(base: StyleProfile, override?: Partial<StyleProfile> | null): StyleProfile {
  if (!override) return base;
  return {
    vehicle_character: override.vehicle_character
      ? coerceCharacter(override.vehicle_character)
      : base.vehicle_character,
    audience: { ...base.audience, ...(override.audience ?? {}) },
    style: mergeKnobs(base.style, override.style),
    rationale: override.rationale ?? base.rationale,
  };
}

/** The immutable video_config snapshot taken at plan approval (§5.5). */
export interface VideoConfig {
  veo_model: 'fast' | 'standard';
  voice: string;
  pacing: StyleKnobs['pacing'];
  camera_energy: StyleKnobs['camera_energy'];
}

export function resolveVideoConfig(profile: StyleProfile): VideoConfig {
  const veoModel = (process.env.VEHICLE_VIDEO_VEO_MODEL ?? 'fast') === 'standard' ? 'standard' : 'fast';
  return {
    veo_model: veoModel,
    voice: profile.style.voice,
    pacing: profile.style.pacing,
    camera_energy: profile.style.camera_energy,
  };
}
