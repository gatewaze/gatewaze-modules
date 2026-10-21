/**
 * Pixel arithmetic on raw frames, with no I/O, so every number the studio
 * decides on is testable with a hand-made buffer.
 *
 * Frames arrive from ffmpeg as rawvideo: `gray` (one byte per pixel) for the
 * sampled contact frames, `rgba` (four bytes) for a cut-out, `rgb24` for a
 * source still. Everything here is integer loops over Buffers; a 640x360
 * frame is 230k pixels and a 1920x1080 cut-out is 2M, both well under a
 * millisecond-per-frame budget that matters when there are a hundred frames.
 */

export interface Box { x0: number; y0: number; x1: number; y1: number }

/** Mean value of a rectangle in a gray frame; the rectangle is clipped to the frame. */
export function regionMean(gray: Buffer, width: number, height: number, x: number, y: number, w: number, h: number): number {
  const x0 = Math.max(0, Math.floor(x)); const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(width, Math.ceil(x + w)); const y1 = Math.min(height, Math.ceil(y + h));
  if (x1 <= x0 || y1 <= y0) return 0;
  let sum = 0; let n = 0;
  for (let yy = y0; yy < y1; yy++) {
    const row = yy * width;
    for (let xx = x0; xx < x1; xx++) { sum += gray[row + xx]; n++; }
  }
  return n ? sum / n : 0;
}

/** Mean gradient magnitude: the edge energy the prototype read from a sobel pass. */
export function sharpness(gray: Buffer, width: number, height: number): number {
  let sum = 0; let n = 0;
  for (let y = 1; y < height - 1; y += 2) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 2) {
      // Adjacent differences, not x-1 to x+1: with the stride of two a
      // centred difference would compare pixels of the same parity and
      // read a checkerboard as flat.
      const gx = gray[row + x + 1] - gray[row + x];
      const gy = gray[row + width + x] - gray[row + x];
      sum += Math.abs(gx) + Math.abs(gy); n++;
    }
  }
  return n ? sum / n : 0;
}

/** Share of pixels brighter than `threshold` (a projector showing white). */
export function whiteFraction(gray: Buffer, threshold = 235, step = 5): number {
  let hot = 0; let n = 0;
  for (let i = 0; i < gray.length; i += step) { n++; if (gray[i] > threshold) hot++; }
  return n ? hot / n : 0;
}

/**
 * The stats one sampled frame is judged on, all from one gray 640x360 frame.
 *
 * The regions are the prototype's, which were found against the two AAIF
 * composite layouts: the sponsor strip at the bottom of the YouTube render,
 * and the slide-over-ticker edge of the stream overlay at 82% height. They
 * are expressed as fractions so a different contact size still works.
 */
export interface FrameStats {
  sharp: number; bottom: number; left: number; mean: number;
  v_in: number; v_out: number; h_in: number; h_out: number;
  s_v_in: number; s_v_out: number; s_h_in: number; s_h_out: number;
  white: number;
}

export function frameStats(gray: Buffer, w: number, h: number): FrameStats {
  const sx = w / 640; const sy = h / 360;
  const r = (x: number, y: number, rw: number, rh: number) => regionMean(gray, w, h, x * sx, y * sy, rw * sx, rh * sy);
  return {
    sharp: sharpness(gray, w, h),
    bottom: r(0, 360 * 0.82, 640, 360 * 0.18),
    left: r(0, 360 * 0.05, 640 * 0.3, 360 * 0.7),
    mean: r(0, 0, 640, 360),
    v_in: r(162, 40, 5, 240), v_out: r(170, 40, 5, 240),
    h_in: r(200, 290, 400, 4), h_out: r(200, 297, 400, 4),
    s_v_in: r(208, 60, 5, 200), s_v_out: r(218, 60, 5, 200),
    s_h_in: r(250, 23, 300, 4), s_h_out: r(250, 30, 300, 4),
    white: whiteFraction(gray),
  };
}

/** Bounds of the opaque pixels of an RGBA image, or null when it is empty. */
export function alphaBounds(rgba: Buffer, width: number, height: number, threshold = 128): Box | null {
  let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < height; y += 2) {
    const row = y * width;
    for (let x = 0; x < width; x += 2) {
      if (rgba[(row + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: Math.min(width - 1, x1 + 1), y1: Math.min(height - 1, y1 + 1) };
}

/** Bounds of the set pixels of a gray mask. */
export function maskBounds(gray: Buffer, width: number, height: number, threshold = 128): Box | null {
  let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < height; y += 2) {
    const row = y * width;
    for (let x = 0; x < width; x += 2) {
      if (gray[row + x] > threshold) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: Math.min(width - 1, x1 + 1), y1: Math.min(height - 1, y1 + 1) };
}

/** How many mask pixels are set, sampled. */
export function maskArea(gray: Buffer, step = 7): number {
  let n = 0;
  for (let i = 0; i < gray.length; i += step) if (gray[i] > 128) n++;
  return n;
}

export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Mean luma of the opaque pixels of an RGBA cut-out. */
export function meanLuma(rgba: Buffer, step = 13): number {
  let sum = 0; let n = 0;
  const px = rgba.length >> 2;
  for (let i = 0; i < px; i += step) {
    const o = i * 4;
    if (rgba[o + 3] > 200) { sum += luma(rgba[o], rgba[o + 1], rgba[o + 2]); n++; }
  }
  return n ? sum / n : 0;
}

/**
 * Projector glare on the face: the share of opaque pixels in the head band
 * (top 30% of the figure's bounds) that are blown out.
 */
export function glareFraction(rgba: Buffer, width: number, bb: Box): number {
  const yTop = bb.y0; const yBot = bb.y0 + Math.floor((bb.y1 - bb.y0) * 0.3);
  let hot = 0; let tot = 0;
  for (let y = yTop; y < yBot; y += 2) {
    for (let x = bb.x0; x < bb.x1; x += 2) {
      const o = (y * width + x) * 4;
      if (rgba[o + 3] > 200) { tot++; if (luma(rgba[o], rgba[o + 1], rgba[o + 2]) > 235) hot++; }
    }
  }
  return tot ? hot / tot : 1;
}

/**
 * How much of the background around the head is a bright screen: in the
 * source still, the share of non-figure pixels (cut-out alpha under 60) in a
 * band around the top third of the figure that are near-white.
 */
export function screenFraction(rgb: Buffer, rgba: Buffer, width: number, height: number, bb: Box): number {
  const y0 = Math.max(0, bb.y0 - 24); const y1 = Math.min(height, bb.y0 + Math.floor((bb.y1 - bb.y0) * 0.33));
  const x0 = Math.max(0, bb.x0 - 60); const x1 = Math.min(width - 1, bb.x1 + 60);
  let hot = 0; let tot = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = y * width + x;
      if (rgba[i * 4 + 3] < 60) {
        tot++;
        if (luma(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) > 225) hot++;
      }
    }
  }
  return tot ? hot / tot : 0;
}

/** Gamma to lift a dark cut-out by, from its mean luma; 1 means leave it. */
export function gammaFor(mean: number): number {
  return mean < 35 ? 1.55 : mean < 50 ? 1.3 : mean < 70 ? 1.12 : 1;
}
