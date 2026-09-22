/**
 * A photo-booth theme: the illustrated booth a guest walks into.
 *
 * Optional, per event. With no theme the guest page offers the booth as
 * a plain list of looks. With one, the booth is a place:
 *
 *   1. the era picker     -- a painted board of eras, or a plain grid
 *   2. an era's board     -- that era's six looks, on painted artwork if
 *                            the theme has it, otherwise on a board built
 *                            in the page from each look's sample picture
 *   3. inside the booth   -- the era's interior, the live selfie camera
 *                            in its window, the coin slot as the shutter
 *
 * WHICH looks an era offers is code (lib/booth-eras.ts); what the booth
 * LOOKS like is the event's, and lives beside its media in storage:
 *
 *   event/<event uuid>/booth-theme/theme.json
 *   event/<event uuid>/booth-theme/<image files named in theme.json>
 *
 * Every position is a fraction of its image (0..1), so artwork can be
 * re-exported at another size without touching the numbers.
 *
 * theme.json is written by an operator, not a guest -- but it reaches
 * every guest's browser, so nothing in it passes unchecked. Image names
 * must be plain file names (they become URLs), and anything malformed
 * means "no theme" (or no such era) rather than a half-working booth.
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
  /** The machine panel under the window. */
  panel: Rect;
}

/** A painted board: tiles drawn on artwork, each naming what it opens. */
export interface PaintedBoard extends BoothScene {
  /** `window`: where on the tile the page drops a picture (a decade's photo of the key people). */
  tiles: Array<Rect & { key: string; window?: Rect }>;
}

export interface ThemeEra {
  interior: BoothInterior;
  /** Painted outside board whose tiles name looks; optional. */
  board: PaintedBoard | null;
  /** A picture for this era's card in a plain era grid; optional. */
  card: string | null;
  /** A sample picture per look id, for a board built in the page. */
  samples: Record<string, string>;
}

export interface BoothTheme {
  /** Painted era picker whose tiles name eras; optional. */
  picker: PaintedBoard | null;
  eras: Record<string, ThemeEra>;
}

const FILE_RE = /^[a-z0-9][a-z0-9_-]{0,80}\.(webp|jpg|jpeg|png)$/;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const MAX_TILES = 12;
const MAX_ERAS = 16;
const MAX_SAMPLES = 24;

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

function file(v: unknown, url: (f: string) => string): string | null {
  return typeof v === 'string' && FILE_RE.test(v) ? url(v) : null;
}

function scene(v: unknown, url: (f: string) => string): BoothScene | null {
  if (!isObj(v)) return null;
  const image = file(v['image'], url);
  const width = v['width'];
  const height = v['height'];
  if (!image) return null;
  if (typeof width !== 'number' || !Number.isInteger(width) || width < 100 || width > 8000) return null;
  if (typeof height !== 'number' || !Number.isInteger(height) || height < 100 || height > 8000) return null;
  const focus = v['focus_x'] === undefined ? 0.5 : frac(v['focus_x']);
  if (focus === null) return null;
  return { image, width, height, focus_x: focus };
}

/** A painted board, keeping only tiles whose key `allowed` accepts. */
function board(v: unknown, url: (f: string) => string, allowed: (key: string) => boolean): PaintedBoard | null {
  const s = scene(v, url);
  if (!s || !isObj(v) || !Array.isArray(v['tiles'])) return null;
  const tiles: PaintedBoard['tiles'] = [];
  for (const t of v['tiles'].slice(0, MAX_TILES)) {
    if (!isObj(t)) continue;
    const r = rect(t);
    const key = t['key'];
    if (!r || typeof key !== 'string' || !allowed(key)) continue;
    const win = t['window'] === undefined ? null : rect(t['window']);
    tiles.push({ ...r, key, ...(win ? { window: win } : {}) });
  }
  return tiles.length > 0 ? { ...s, tiles } : null;
}

function interior(v: unknown, url: (f: string) => string): BoothInterior | null {
  const s = scene(v, url);
  if (!s || !isObj(v)) return null;
  const win = rect(v['window']);
  const coin = rect(v['coin']);
  const panel = rect(v['panel']);
  return win && coin && panel ? { ...s, window: win, coin, panel } : null;
}

/**
 * Validate a stored theme and resolve its images to URLs.
 *
 * `looksFor(era)` is the set of look ids that era may offer at this
 * event; painted tiles and samples naming anything else are dropped. An
 * era without a valid interior is dropped -- a booth needs an inside.
 */
export function parseBoothTheme(
  raw: unknown,
  looksFor: (era: string) => ReadonlySet<string>,
  url: (file: string) => string,
): BoothTheme | null {
  if (!isObj(raw) || raw['version'] !== 2 || !isObj(raw['eras'])) return null;

  const eras: Record<string, ThemeEra> = {};
  for (const [key, v] of Object.entries(raw['eras']).slice(0, MAX_ERAS)) {
    if (!KEY_RE.test(key) || !isObj(v)) continue;
    const inside = interior(v['interior'], url);
    if (!inside) continue;
    const looks = looksFor(key);
    const samples: Record<string, string> = {};
    if (isObj(v['samples'])) {
      for (const [look, f] of Object.entries(v['samples']).slice(0, MAX_SAMPLES)) {
        const u = looks.has(look) ? file(f, url) : null;
        if (u) samples[look] = u;
      }
    }
    eras[key] = {
      interior: inside,
      board: v['board'] === undefined ? null : board(v['board'], url, (k) => looks.has(k)),
      card: file(v['card'], url),
      samples,
    };
  }
  if (Object.keys(eras).length === 0) return null;

  const picker = raw['picker'] === undefined ? null : board(raw['picker'], url, (k) => k in eras);
  return { picker, eras };
}
