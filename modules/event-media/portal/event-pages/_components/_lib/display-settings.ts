/**
 * Projector settings: their shape, their defaults, and the upgrade path
 * for settings saved by an older build.
 *
 * Extracted from DisplayView so it can be tested. It could not be
 * before, and the first version shipped a fault that silently replaced
 * a saved projector setup with the new defaults — exactly the kind of
 * thing nobody notices until the screen is already in front of guests.
 */

export type SlideEffect =
  | 'wedflix' | 'cinematic' | 'kenburns' | 'grade' | 'fade' | 'slide' | 'zoom' | 'blur'

/**
 * Everything that belongs to one stream rather than to the screen.
 *
 * The day's photographs and the booth's posters want different
 * treatment — Wedflix over a landscape snapshot, a quiet fade across a
 * wall of portrait posters — so each stream carries its own.
 */
export interface StreamSettings {
  mode: 'slideshow' | 'wall'
  effect: SlideEffect
  intervalMs: number
  camera: 'pan' | 'panzoom'
  /** Wall columns. 0 picks a best-fit grid from the photo count. */
  columns: number
}

export const DEFAULT_DAY: StreamSettings = {
  mode: 'slideshow', effect: 'wedflix', intervalMs: 8000, camera: 'pan', columns: 0,
}

// The posters are finished artwork with their own titles, so they get a
// quiet fade and three across the screen rather than a browse card.
export const DEFAULT_BOOTH: StreamSettings = {
  mode: 'wall', effect: 'fade', intervalMs: 9000, camera: 'pan', columns: 3,
}

/** The fields an older build wrote for the whole screen at once. */
export interface LegacyFlat {
  mode?: 'slideshow' | 'wall'
  effect?: SlideEffect
  intervalMs?: number
  camera?: 'pan' | 'panzoom'
}

function merge(stored: unknown, base: StreamSettings): StreamSettings {
  return stored && typeof stored === 'object'
    ? { ...base, ...(stored as Partial<StreamSettings>) }
    : base
}

/**
 * Work out the per-stream settings from whatever was in storage.
 *
 * `stored` MUST be the parsed saved object, not that object merged over
 * the defaults. Merging first is what broke this: the defaults always
 * supply a `day`, so there is no longer any way to tell whether the
 * person had one, and a legacy save loses its effect every time.
 */
export function migrateStreams(stored: Record<string, unknown> | null | undefined): {
  day: StreamSettings
  booth: StreamSettings
} {
  const s = stored ?? {}
  const legacy = s as LegacyFlat
  // A save from before the split describes the day, because the day was
  // the only stream those settings could have been chosen for.
  const foldedDay: StreamSettings = {
    mode: legacy.mode ?? DEFAULT_DAY.mode,
    effect: legacy.effect ?? DEFAULT_DAY.effect,
    intervalMs: legacy.intervalMs ?? DEFAULT_DAY.intervalMs,
    camera: legacy.camera ?? DEFAULT_DAY.camera,
    columns: 0,
  }
  return {
    day: 'day' in s ? merge(s['day'], DEFAULT_DAY) : foldedDay,
    booth: 'booth' in s ? merge(s['booth'], DEFAULT_BOOTH) : DEFAULT_BOOTH,
  }
}

/** Streams are the top-level choice; anything else reads as the day. */
export function normaliseStream(v: unknown): 'day' | 'booth' | 'mix' {
  return v === 'booth' || v === 'mix' ? v : 'day'
}
