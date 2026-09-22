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

/**
 * A Polaroid that fits the screen: the photo at the booth window's
 * aspect, a narrow border on three sides and the deep one at the bottom,
 * as large as it can be between the top bar and the buttons under it.
 */
export function polaroidSize(
  viewW: number,
  viewH: number,
  photoAspect: number,
  reserveH: number,
): { photoW: number; photoH: number; side: number; bottom: number; frameW: number; frameH: number } {
  const a = photoAspect > 0 && Number.isFinite(photoAspect) ? photoAspect : 0.75
  const SIDE = 0.065
  const BOTTOM = 0.24
  const byWidth = (viewW * 0.86) / (1 + 2 * SIDE)
  const byHeight = Math.max(80, viewH - reserveH) / (1 / a + SIDE + BOTTOM)
  const photoW = Math.max(80, Math.min(byWidth, byHeight, 520))
  const side = photoW * SIDE
  const bottom = photoW * BOTTOM
  const photoH = photoW / a
  return { photoW, photoH, side, bottom, frameW: photoW + 2 * side, frameH: photoH + side + bottom }
}

/**
 * A sideways phone, standing close to the booth.
 *
 * The artwork is a portrait booth. Scaled to a landscape screen's height
 * it becomes a narrow strip down the middle -- the camera window a few
 * centimetres across, the tiles too small to hit. So in landscape the
 * page steps closer instead: the stage is scaled until the booth's own
 * window fills `share` of the screen height, and centred on that window.
 * Whatever falls outside the screen (usually the coin slot below) is
 * covered by the shutter inside the window, which does the same thing.
 *
 * Returned in the same shape as stageRect, so the tiles, window, coin
 * slot and panel keep their positions within the artwork.
 */
export function zoomToWindow(
  viewW: number,
  viewH: number,
  imgW: number,
  imgH: number,
  win: { x: number; y: number; w: number; h: number },
  share = 0.82,
): Box {
  // Tall enough that the window takes its share of the screen, but never
  // smaller than filling the height (that is the portrait behaviour).
  const height = Math.max(viewH, (viewH * share) / win.h)
  const width = height * (imgW / imgH)
  // Put the window in the middle of the screen. Where the artwork is
  // bigger than the screen it is held over the edges, so no gap opens at
  // the side or the top; where it is narrower than a wide screen (the
  // usual case, the artwork being portrait) it simply sits centred and
  // the page's ambient fill covers the rest.
  const centre = (viewLen: number, len: number, mid: number) => {
    const wanted = viewLen / 2 - mid * len
    return len >= viewLen ? Math.min(0, Math.max(viewLen - len, wanted)) : wanted
  }
  return {
    left: centre(viewW, width, win.x + win.w / 2),
    top: centre(viewH, height, win.y + win.h / 2),
    width,
    height,
  }
}
