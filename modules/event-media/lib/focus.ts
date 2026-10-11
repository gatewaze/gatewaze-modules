/**
 * A lens the phone did not have.
 *
 * A phone shoots a tiny sensor at a wide angle, so everything from the
 * tablecloth to the far wall is in focus at once. That is the single
 * loudest "taken on a phone" cue, and no amount of tone and colour work
 * touches it: measured on 2026-10-01, the guests' photographs separate
 * their subjects from the background by a sharpness ratio of 0.68 to
 * 1.17, where separating them at all starts around 3.
 *
 * NOTHING IS INVENTED HERE. Two models supply measurements -- a depth
 * map and a subject mask, both already used by the booth -- and the blur
 * itself is arithmetic: every output pixel is a weighted sum of pixels
 * that were already in the photograph. A face cannot change, because no
 * pixel is drawn, only mixed.
 *
 * The focal plane sits at the subject rather than at the nearest thing.
 * The first version of this took the nearest depth as the subject and
 * produced a photograph of sharp table flowers with the bride and groom
 * soft behind them -- which is a real lens error, and not one anybody
 * wants reproduced.
 */

/** How many increasingly blurred copies a lens is approximated by. */
export const LENS_STEPS = 4;

/**
 * How much of a lens to put in front of the photograph.
 *
 * The number is the frame's width divided by this, as a blur radius, so
 * the effect is the same whatever size the photograph is rendered at.
 *
 * GENTLE IS THE DEFAULT, and it is the default because Dan looked at all
 * three across six photographs on 2026-10-01 and said so. The measured
 * separation keeps climbing with the stronger settings -- it reaches 220
 * at strong -- but that number rises with any blur at all and says
 * nothing about whether the result looks like a photograph. The eye is
 * the judge of this one.
 */
export const APERTURES = { gentle: 140, medium: 70, strong: 38 } as const;
export type Aperture = keyof typeof APERTURES;

/** The blur radius for a frame of this width. */
export function radiusFor(width: number, aperture: Aperture = 'gentle'): number {
  return Math.max(3, Math.round(width / APERTURES[aperture]));
}

/**
 * Depth either side of the focal plane that stays sharp, as a fraction
 * of the depth range. Wider than a real lens on purpose: a group does
 * not stand on one plane, and dropping somebody at the edge of a row out
 * of focus looks like a mistake rather than a photograph.
 */
const DEPTH_OF_FIELD = 0.22;

/**
 * How far past the depth of field blur keeps growing. A real lens does
 * not stop softening once something is out of focus -- the far wall is
 * softer than the chair behind the subject -- and flattening everything
 * beyond one threshold to the same blur is what makes a cut-out look.
 */
const FALLOFF = 2.4;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Where to focus: the median depth over the subject.
 *
 * `mask` is the subject's alpha, 0..255. Taking the median rather than
 * the mean means a few stray pixels of background caught in the mask
 * cannot drag the plane off the people.
 */
export function focalPlane(depth: Uint8ClampedArray, mask: Uint8ClampedArray, stride = 4): number {
  const bins = new Uint32Array(256);
  let n = 0;
  const step = Math.max(1, Math.floor(stride)) * 4;
  for (let i = 0; i < depth.length && i < mask.length; i += step) {
    if (mask[i + 3]! < 128 && mask[i]! < 128) continue;   // not the subject
    bins[depth[i]!]! += 1;
    n += 1;
  }
  if (n === 0) return -1;
  let seen = 0;
  for (let v = 0; v < 256; v += 1) {
    seen += bins[v]!;
    if (seen * 2 >= n) return v / 255;
  }
  return 0.5;
}

/**
 * How blurred each pixel should be, 0..1, from its distance to the
 * focal plane in either direction.
 *
 * A real lens defocuses what is nearer than the subject as well as what
 * is further away, which is why the foreground flowers go soft too.
 */
export function blurField(
  depth: Uint8ClampedArray, mask: Uint8ClampedArray, plane: number,
  width: number, height: number,
): Float32Array {
  const n = width * height;
  const out = new Float32Array(n);
  if (plane < 0) return out;
  for (let p = 0; p < n; p += 1) {
    const i = p * 4;
    const d = (depth[i] ?? 128) / 255;
    const gap = Math.abs(d - plane);
    let away = clamp((gap / DEPTH_OF_FIELD) ** (1 / FALLOFF), 0, 1);
    // The subject is held sharp outright, whatever the depth map says
    // about the edges of somebody's hair.
    const subject = Math.max(mask[i + 3] ?? 0, mask[i] ?? 0) / 255;
    away *= 1 - clamp(subject, 0, 1);
    out[p] = away;
  }
  return out;
}

/**
 * sRGB is not light. A pixel of 255 carries roughly twenty times the
 * light of a pixel of 128, not twice it, so averaging encoded values
 * dims every highlight it touches -- which is exactly why a Gaussian
 * blur of a background looks like smeared mud and a lens looks like
 * bokeh. Defocus is an optical average, so it has to happen in linear
 * light and be encoded back afterwards.
 */
const TO_LINEAR = new Float32Array(256);
for (let v = 0; v < 256; v += 1) {
  const c = v / 255;
  TO_LINEAR[v] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function encodeSrgb(x: number): number {
  const c = x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
  return clamp(c * 255, 0, 255);
}

/**
 * The shape a lens actually makes.
 *
 * An out-of-focus point does not become a soft smudge; it becomes a
 * disc, the circle of confusion, with a defined edge. That edge is what
 * the eye reads as "defocused" rather than "blurred", and a Gaussian has
 * none of it. The disc is convolved at reduced resolution, which costs
 * almost nothing and loses nothing: the detail is being discarded anyway.
 */
function discBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius < 1) return src;
  const scale = Math.max(1, Math.round(radius / 3.5));
  const sw = Math.max(1, Math.floor(w / scale));
  const sh = Math.max(1, Math.floor(h / scale));
  const small = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      let acc = 0, n = 0;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const sy = Math.min(h - 1, y * scale + dy);
          const sx = Math.min(w - 1, x * scale + dx);
          acc += src[sy * w + sx]!; n += 1;
        }
      }
      small[y * sw + x] = acc / n;
    }
  }
  const r = Math.max(1, Math.round(radius / scale));
  const offs: number[] = [];
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (dx * dx + dy * dy <= r * r) offs.push(dy * sw + dx, dx, dy);
    }
  }
  const blurred = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      let acc = 0, n = 0;
      for (let k = 0; k < offs.length; k += 3) {
        const nx = x + offs[k + 1]!, ny = y + offs[k + 2]!;
        if (nx < 0 || ny < 0 || nx >= sw || ny >= sh) continue;
        acc += small[ny * sw + nx]!; n += 1;
      }
      blurred[y * sw + x] = n ? acc / n : small[y * sw + x]!;
    }
  }
  // Back up, bilinear, so the disc edges do not come back as squares.
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const fy = Math.min(sh - 1, y / scale), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x += 1) {
      const fx = Math.min(sw - 1, x / scale), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = blurred[y0 * sw + x0]! * (1 - tx) + blurred[y0 * sw + x1]! * tx;
      const b = blurred[y1 * sw + x0]! * (1 - tx) + blurred[y1 * sw + x1]! * tx;
      out[y * w + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/** A separable box blur, run three times, which is a Gaussian for free. */
function blurOnce(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const tmp = new Float32Array(src.length);
  const span = 2 * r + 1;
  for (let y = 0; y < h; y += 1) {
    let acc = 0;
    for (let x = -r; x <= r; x += 1) acc += src[y * w + clamp(x, 0, w - 1)]!;
    for (let x = 0; x < w; x += 1) {
      tmp[y * w + x] = acc / span;
      acc += src[y * w + clamp(x + r + 1, 0, w - 1)]! - src[y * w + clamp(x - r, 0, w - 1)]!;
    }
  }
  for (let x = 0; x < w; x += 1) {
    let acc = 0;
    for (let y = -r; y <= r; y += 1) acc += tmp[clamp(y, 0, h - 1) * w + x]!;
    for (let y = 0; y < h; y += 1) {
      dst[y * w + x] = acc / span;
      acc += tmp[clamp(y + r + 1, 0, h - 1) * w + x]! - tmp[clamp(y - r, 0, h - 1) * w + x]!;
    }
  }
}

function gaussian(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius / 2));
  let a: Float32Array = Float32Array.from(src);
  let b: Float32Array = new Float32Array(src.length);
  for (let i = 0; i < 3; i += 1) {
    blurOnce(a, b, w, h, r);
    const t = a; a = b; b = t;
  }
  return a;
}

/**
 * Apply the defocus, in place.
 *
 * A stack of increasingly blurred copies, mixed by how far each pixel
 * sits from the focal plane. Mixing between them rather than blurring
 * each pixel by its own radius is what keeps a sharp subject from
 * bleeding into the soft background behind it.
 */
export function applyFocus(
  data: Uint8ClampedArray, width: number, height: number,
  field: Float32Array, strength = 13,
): void {
  const n = width * height;
  if (n === 0 || field.length !== n) return;
  // Soften the field itself, so focus changes gradually rather than at a
  // hard line. Proportional to the frame: a fixed radius is nothing on a
  // 2560px photograph and smears straight across the subject on a small
  // one, which is how this first failed its own test.
  const soft = gaussian(
    Float32Array.from(field), width, height,
    clamp(Math.min(width, height) / 100, 1, 16),
  );

  for (let c = 0; c < 3; c += 1) {
    // Into light, where an average means something optical.
    const plane = new Float32Array(n);
    for (let p = 0; p < n; p += 1) plane[p] = TO_LINEAR[data[p * 4 + c]!]!;
    const levels: Float32Array[] = [plane];
    for (let k = 1; k <= LENS_STEPS; k += 1) {
      levels.push(discBlur(plane, width, height, (strength * k) / LENS_STEPS));
    }
    for (let p = 0; p < n; p += 1) {
      const idx = clamp(soft[p]!, 0, 1) * LENS_STEPS;
      const lo = Math.floor(idx);
      const hi = Math.min(LENS_STEPS, lo + 1);
      const t = idx - lo;
      data[p * 4 + c] = encodeSrgb(levels[lo]![p]! * (1 - t) + levels[hi]![p]! * t);
    }
  }
}
