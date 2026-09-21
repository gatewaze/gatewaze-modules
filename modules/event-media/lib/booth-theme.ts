/**
 * A photo-booth theme: the illustrated booth a guest walks into.
 *
 * Optional, per event. With no theme the guest page offers the booth as
 * a plain list of looks, as it always has. With one, the guest first
 * sees the OUTSIDE of a booth -- a board of looks to choose from -- and
 * choosing one takes them INSIDE, where their live selfie camera sits in
 * the booth's window and the coin slot is the shutter.
 *
 * A theme is artwork plus geometry, so it lives beside the event's media
 * in storage rather than in code:
 *
 *   event/<event uuid>/booth-theme/theme.json
 *   event/<event uuid>/booth-theme/<image files named in theme.json>
 *
 * Every position is a fraction of its image (0..1), so the artwork can be
 * re-exported at another size without touching the numbers.
 *
 * This file is the only reader of theme.json, and theme.json is written
 * by an operator, not a guest -- but it still reaches every guest's
 * browser, so nothing in it is passed through unchecked. Image names must
 * be plain file names (they become URLs), looks must be effects the link
 * actually offers, and anything malformed means "no theme" rather than a
 * half-working booth.
 */

export interface Rect { x: number; y: number; w: number; h: number }

export interface BoothScene {
  image: string;
  /** Natural size, so the page can lay the scene out before it loads. */
  width: number;
  height: number;
  /** Where to keep in view when a narrow screen crops the sides (0..1). */
  focus_x: number;
}

export interface BoothInterior extends BoothScene {
  /** The booth's glass, where the live camera and the result go. */
  window: Rect;
  /** The coin slot -- the shutter. */
  coin: Rect;
  /** The machine panel under the window, where the controls sit. */
  panel: Rect;
}

export interface BoothTile extends Rect {
  /** An effect id from the catalogue (lib/booth-effects.ts). */
  effect: string;
  /** Which interior to walk into; the default when absent. */
  interior?: string;
}

export interface BoothTheme {
  outside: BoothScene & { tiles: BoothTile[] };
  interiors: Record<string, BoothInterior>;
  default_interior: string;
}

const FILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}\.(webp|jpg|jpeg|png)$/;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_TILES = 12;
const MAX_INTERIORS = 16;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function frac(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

function rect(v: unknown): Rect | null {
  if (!isObj(v)) return null;
  const x = frac(v['x']), y = frac(v['y']), w = frac(v['w']), h = frac(v['h']);
  if (x === null || y === null || w === null || h === null) return null;
  if (w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) return null;
  return { x, y, w, h };
}

function scene(v: unknown, url: (file: string) => string): BoothScene | null {
  if (!isObj(v)) return null;
  const image = v['image'];
  const width = v['width'];
  const height = v['height'];
  if (typeof image !== 'string' || !FILE_RE.test(image)) return null;
  if (typeof width !== 'number' || !Number.isInteger(width) || width < 100 || width > 8000) return null;
  if (typeof height !== 'number' || !Number.isInteger(height) || height < 100 || height > 8000) return null;
  const focus = v['focus_x'] === undefined ? 0.5 : frac(v['focus_x']);
  if (focus === null) return null;
  return { image: url(image), width, height, focus_x: focus };
}

/**
 * Validate a stored theme and resolve its images to URLs.
 *
 * `effects` is the set of looks this link offers; a tile naming any other
 * is dropped, and a theme left with no tiles is no theme at all.
 */
export function parseBoothTheme(
  raw: unknown,
  effects: ReadonlySet<string>,
  url: (file: string) => string,
): BoothTheme | null {
  if (!isObj(raw) || raw['version'] !== 1) return null;

  const interiorsRaw = raw['interiors'];
  if (!isObj(interiorsRaw)) return null;
  const interiors: Record<string, BoothInterior> = {};
  for (const [key, v] of Object.entries(interiorsRaw).slice(0, MAX_INTERIORS)) {
    if (!KEY_RE.test(key) || !isObj(v)) continue;
    const s = scene(v, url);
    const win = rect(v['window']);
    const coin = rect(v['coin']);
    const panel = rect(v['panel']);
    if (!s || !win || !coin || !panel) continue;
    interiors[key] = { ...s, window: win, coin, panel };
  }

  const def = raw['default_interior'];
  if (typeof def !== 'string' || !interiors[def]) return null;

  const outsideRaw = raw['outside'];
  if (!isObj(outsideRaw)) return null;
  const outside = scene(outsideRaw, url);
  if (!outside || !Array.isArray(outsideRaw['tiles'])) return null;

  const tiles: BoothTile[] = [];
  for (const t of outsideRaw['tiles'].slice(0, MAX_TILES)) {
    if (!isObj(t)) continue;
    const r = rect(t);
    const effect = t['effect'];
    if (!r || typeof effect !== 'string' || !effects.has(effect)) continue;
    const interior = t['interior'];
    tiles.push({
      ...r,
      effect,
      ...(typeof interior === 'string' && interiors[interior] ? { interior } : {}),
    });
  }
  if (tiles.length === 0) return null;

  return { outside: { ...outside, tiles }, interiors, default_interior: def };
}
