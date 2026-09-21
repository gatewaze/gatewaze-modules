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
  /** Soften the incoming photo through a cinematic dissolve. */
  blurTransition: boolean
}

/**
 * The four things the projector can show. Each is its own album and
 * carries its own treatment.
 *
 *   preload  the selfies shown before the day's photographs exist
 *   ready    Getting ready: guests' photos from before they arrive
 *   day      what guests upload on the day
 *   booth    the photo booth's posters
 */
export type ViewName = 'preload' | 'ready' | 'day' | 'booth'

/** Every view, in the order the panel lists them and a rotation runs. */
export const VIEW_ORDER: readonly ViewName[] = ['preload', 'ready', 'day', 'booth']

export const VIEW_LABEL: Record<ViewName, string> = {
  preload: 'Preload',
  ready: 'Getting ready',
  day: 'The day',
  booth: 'Photo booth',
}

/** What "in turn" rotated through before it could be chosen. */
export const DEFAULT_ROTATION: readonly ViewName[] = ['day', 'booth']

// The selfies are stand-ins, never billed as programmes, so they get the
// cinematic treatment rather than Wedflix.
export const DEFAULT_PRELOAD: StreamSettings = {
  mode: 'slideshow', effect: 'cinematic', intervalMs: 8000, camera: 'pan',
  columns: 0, blurTransition: true,
}

// Guests' own photographs, like the day's, so the same treatment; not
// Wedflix by default, because the morning's photos are the warm-up.
export const DEFAULT_READY: StreamSettings = {
  mode: 'slideshow', effect: 'cinematic', intervalMs: 8000, camera: 'pan',
  columns: 0, blurTransition: true,
}

export const DEFAULT_DAY: StreamSettings = {
  mode: 'slideshow', effect: 'wedflix', intervalMs: 8000, camera: 'pan',
  columns: 0, blurTransition: true,
}

// The posters are finished artwork with their own titles, so they get a
// quiet fade and three across the screen rather than a browse card.
export const DEFAULT_BOOTH: StreamSettings = {
  mode: 'wall', effect: 'fade', intervalMs: 9000, camera: 'pan',
  columns: 3, blurTransition: true,
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
  preload: StreamSettings
  ready: StreamSettings
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
    blurTransition: DEFAULT_DAY.blurTransition,
  }
  return {
    preload: 'preload' in s ? merge(s['preload'], DEFAULT_PRELOAD) : DEFAULT_PRELOAD,
    ready: 'ready' in s ? merge(s['ready'], DEFAULT_READY) : DEFAULT_READY,
    day: 'day' in s ? merge(s['day'], DEFAULT_DAY) : foldedDay,
    booth: 'booth' in s ? merge(s['booth'], DEFAULT_BOOTH) : DEFAULT_BOOTH,
  }
}

/**
 * Streams are the top-level choice. Anything unrecognised opens on
 * Preload, which is the one view guaranteed to have photos before the
 * day's uploads exist -- so a fresh or garbled setting never opens on an
 * empty screen.
 */
export function normaliseStream(v: unknown): ViewName | 'mix' {
  return v === 'mix' || (VIEW_ORDER as readonly unknown[]).includes(v) ? (v as ViewName | 'mix') : 'preload'
}

/**
 * Which views "in turn" rotates through, from whatever was saved: known
 * views only, each once, in panel order. A save from before the choice
 * existed -- or one that has lost every view -- rotates the day and the
 * booth, which is what "in turn" always meant until now.
 */
export function normaliseRotation(v: unknown): ViewName[] {
  const picked = Array.isArray(v) ? v : []
  const out = VIEW_ORDER.filter((name) => picked.includes(name))
  return out.length > 0 ? out : [...DEFAULT_ROTATION]
}

/**
 * The next view in a rotation, skipping any with nothing to show, so the
 * screen never cuts to an empty album. When nothing else has photos it
 * stays where it is; when the current view has left the rotation it
 * starts again from the first.
 */
export function nextInRotation(
  rotation: readonly ViewName[],
  current: ViewName,
  hasPhotos: (view: ViewName) => boolean,
): ViewName {
  if (rotation.length === 0) return current
  const at = rotation.indexOf(current)
  for (let step = 1; step <= rotation.length; step++) {
    const candidate = rotation[(at + step) % rotation.length]!
    if (candidate === current) break
    if (hasPhotos(candidate)) return candidate
  }
  return at === -1 ? rotation[0]! : current
}
