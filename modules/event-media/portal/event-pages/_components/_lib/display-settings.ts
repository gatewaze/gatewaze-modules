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
  | 'picflix' | 'cinematic' | 'kenburns' | 'grade' | 'fade' | 'slide' | 'zoom' | 'blur'

/**
 * Everything that belongs to one stream rather than to the screen.
 *
 * The day's photographs and the preload selfies want different
 * treatment — Picflix over a landscape snapshot, a cinematic drift for
 * the stand-ins — so each stream carries its own.
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
 * The things the projector can show. Each is its own album and carries
 * its own treatment.
 *
 *   preload  the selfies shown before the day's photographs exist
 *   day      what guests upload on the day (Getting ready and the
 *            evening reception included, see dayAlbums)
 */
export type ViewName = 'preload' | 'day'

/** Every view, in the order the panel lists them and a rotation runs. */
export const VIEW_ORDER: readonly ViewName[] = ['preload', 'day']

export const VIEW_LABEL: Record<ViewName, string> = {
  preload: 'Preload',
  day: 'The day',
}

/**
 * Getting ready is part of the day on the projector. Photos taken before
 * the event are still filed under Getting ready, but The day shows them
 * alongside its own until The day album has this many photos of its own;
 * from then on it shows The day alone. There is no separate projector
 * view -- or setting -- for Getting ready (asked 2026-09-22).
 */
export const DAY_ONLY_AFTER = 20

/** Which albums The day view draws from, given every photo loaded. */
export function dayAlbums(all: ReadonlyArray<{ album?: string | null }>, threshold: number = DAY_ONLY_AFTER): Set<string> {
  let own = 0
  // The evening reception is its own album but the same evening: the
  // projector's The day view shows both, or the party would vanish off
  // the screen at half past six.
  for (const p of all) if (p.album === 'day' || p.album === 'evening') own++
  return own >= threshold ? new Set(['day', 'evening']) : new Set(['day', 'evening', 'ready'])
}

/**
 * What "in turn" rotates through until it is chosen: the day alone, so
 * the stand-in Preload never cuts in unless an organiser asks for it.
 */
export const DEFAULT_ROTATION: readonly ViewName[] = ['day']

// The selfies are stand-ins, never billed as programmes, so they get the
// cinematic treatment rather than Picflix.
export const DEFAULT_PRELOAD: StreamSettings = {
  mode: 'slideshow', effect: 'cinematic', intervalMs: 8000, camera: 'pan',
  columns: 0, blurTransition: true,
}

export const DEFAULT_DAY: StreamSettings = {
  mode: 'slideshow', effect: 'picflix', intervalMs: 8000, camera: 'pan',
  columns: 0, blurTransition: true,
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
  day: StreamSettings
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
    day: 'day' in s ? merge(s['day'], DEFAULT_DAY) : foldedDay,
  }
}

/**
 * Streams are the top-level choice. Anything unrecognised opens on
 * Preload, which is the one view guaranteed to have photos before the
 * day's uploads exist -- so a fresh or garbled setting never opens on an
 * empty screen.
 */
export function normaliseStream(v: unknown): ViewName | 'mix' {
  // Getting ready is shown as part of the day now.
  if (v === 'ready') return 'day'
  return v === 'mix' || (VIEW_ORDER as readonly unknown[]).includes(v) ? (v as ViewName | 'mix') : 'preload'
}

/**
 * Which views "in turn" rotates through, from whatever was saved: known
 * views only, each once, in panel order. A save from before the choice
 * existed -- or one that has lost every view -- gets DEFAULT_ROTATION.
 */
export function normaliseRotation(v: unknown): ViewName[] {
  const picked = (Array.isArray(v) ? v : []).map((x) => (x === 'ready' ? 'day' : x))
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
