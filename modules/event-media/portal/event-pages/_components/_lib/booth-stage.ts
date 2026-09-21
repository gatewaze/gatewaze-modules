/**
 * Geometry for the illustrated photo booth.
 *
 * A booth scene is a tall painting (about 9:16) with things drawn on it
 * that must stay tappable -- the board's tiles outside, the coin slot and
 * the camera window inside. Everything is positioned in fractions of the
 * painting, so the one job here is deciding where the painting sits on a
 * given screen.
 *
 * Phones are taller than the painting, so it fills the height and loses
 * some width. Which side loses it is the scene's `focus`: outside, the
 * board is on the right and the curtain on the left can go; inside, the
 * window is central. A screen WIDER than the painting (a laptop) shows
 * all of it, full height, centred -- never cropping top or bottom, which
 * is where the coin slot and the board's title live.
 */

export interface Box { left: number; top: number; width: number; height: number }

export function stageRect(
  viewW: number,
  viewH: number,
  imgW: number,
  imgH: number,
  focusX: number,
): Box {
  const height = viewH
  const width = viewH * (imgW / imgH)
  const f = Math.min(1, Math.max(0, focusX))
  const left = width > viewW ? (viewW - width) * f : (viewW - width) / 2
  return { left, top: 0, width, height }
}

/**
 * The part of a camera frame that fills a window of the given aspect
 * (width / height) the way CSS object-fit: cover does -- so the photo
 * taken is exactly the picture the guest saw in the booth's window.
 */
export function coverCrop(
  srcW: number,
  srcH: number,
  aspect: number,
): { sx: number; sy: number; sw: number; sh: number } {
  if (srcW <= 0 || srcH <= 0 || !(aspect > 0)) return { sx: 0, sy: 0, sw: srcW, sh: srcH }
  if (srcW / srcH > aspect) {
    const sw = srcH * aspect
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH }
  }
  const sh = srcW / aspect
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh }
}

/** Percent-positioning for something drawn on the painting. */
export function pctStyle(r: { x: number; y: number; w: number; h: number }): {
  left: string; top: string; width: string; height: string
} {
  const p = (v: number) => `${(v * 100).toFixed(3)}%`
  return { left: p(r.x), top: p(r.y), width: p(r.w), height: p(r.h) }
}
