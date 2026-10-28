/**
 * The rules behind an album played as a slideshow (migration 033).
 *
 * A photographer's full delivery is thousands of frames shot in bursts,
 * and played in the order they were taken at a few a second it reads
 * almost as film (asked 2026-10-28). These are the parts of that which
 * do not need a browser: the speeds on offer, how big a frame to ask
 * for, which page a frame is on, and how far ahead to load.
 */

/** Frames a second the viewer can choose from. */
export const SPEEDS = [1, 2, 3, 5] as const
export type Speed = (typeof SPEEDS)[number]
export const DEFAULT_SPEED: Speed = 2

/** Frames asked of the gallery at once. The API takes at most 200. */
export const FRAME_PAGE = 200

/** A speed from anywhere (a stored choice, a query), or the default. */
export function speedOf(value: unknown): Speed {
  const n = Number(value)
  return (SPEEDS as readonly number[]).includes(n) ? (n as Speed) : DEFAULT_SPEED
}

/** How long one frame stays on screen at this speed. */
export function frameMs(speed: Speed): number {
  return Math.round(1000 / speed)
}

/**
 * The width to ask the CDN for, from the screen.
 *
 * Sized by the screen's shorter side: a portrait photograph on a wide
 * screen is as tall as the screen, so its width is less than the
 * screen's height, and on a phone held upright every photograph is as
 * wide as the phone. Kept to three sizes so viewers on similar screens
 * ask for the same URL and share the CDN's copy.
 *
 * Measured on the wedding's photographs through Bunny as WebP at
 * FRAME_QUALITY (2026-10-28): 640 is about 150KB, 960 about 320KB, 1280
 * about 520KB. At three a second 960 is about 8 Mbit/s, which a phone on
 * a decent connection keeps up with; 1600 was a megabyte a frame.
 */
export function frameWidth(viewportWidth: number, viewportHeight: number, pixelRatio: number): number {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? Math.min(pixelRatio, 2) : 1
  const want = Math.min(viewportWidth, viewportHeight) * ratio
  if (want <= 700) return 640
  if (want <= 1100) return 960
  return 1280
}

/** JPEG/WebP quality asked of the CDN for a frame. On screen for a third of a second. */
export const FRAME_QUALITY = 70

/** A frame's URL: the object, resized by the CDN. A URL already carrying a query is left alone. */
export function frameUrl(objectUrl: string, width: number): string {
  return objectUrl.includes('?') ? objectUrl : `${objectUrl}?width=${width}&quality=${FRAME_QUALITY}`
}

/** The offset of the gallery page that holds this frame. */
export function pageStart(index: number): number {
  return Math.floor(Math.max(0, index) / FRAME_PAGE) * FRAME_PAGE
}

/**
 * How many frames to have loaded ahead of the one on screen: three
 * seconds of playing, and never fewer than six, so a short stall on the
 * network does not stop the picture.
 */
export function lookahead(speed: Speed): number {
  return Math.max(6, speed * 3)
}

/**
 * The frames worth keeping loaded around the one on screen. One behind,
 * for stepping back, and the lookahead in front. Everything else can be
 * let go, or four thousand decoded photographs would sit in memory.
 */
export function keepWindow(index: number, speed: Speed, total: number): { from: number; to: number } {
  const from = Math.max(0, index - 1)
  const to = Math.min(Math.max(total - 1, 0), index + lookahead(speed))
  return { from, to }
}

/** "1:05" for a number of seconds: how long the album takes to play. */
export function playLength(frames: number, speed: Speed): string {
  const secs = Math.max(0, Math.round(frames / speed))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
