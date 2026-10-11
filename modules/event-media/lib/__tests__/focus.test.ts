import { describe, it, expect } from 'vitest';
import { LENS_STEPS, applyFocus, blurField, focalPlane } from '../focus.js';

/** depth: near is bright. mask: the subject's alpha. */
function scene(w = 40, h = 40) {
  const depth = new Uint8ClampedArray(w * h * 4);
  const mask = new Uint8ClampedArray(w * h * 4);
  const img = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const foreground = y > h * 0.8;          // table, nearest
      const subject = y > h * 0.35 && y < h * 0.7 && x > w * 0.25 && x < w * 0.75;
      const d = foreground ? 240 : subject ? 140 : 40;
      depth[i] = d; depth[i + 1] = d; depth[i + 2] = d; depth[i + 3] = 255;
      const a = subject ? 255 : 0;
      mask[i] = a; mask[i + 1] = a; mask[i + 2] = a; mask[i + 3] = a;
      // a checkerboard, so blurring is measurable as a loss of contrast
      const v = (x + y) % 2 === 0 ? 30 : 220;
      img[i] = v; img[i + 1] = v; img[i + 2] = v; img[i + 3] = 255;
    }
  }
  return { depth, mask, img, w, h };
}

/**
 * Local contrast inside a box: high when sharp, low when blurred.
 *
 * The box matters. Measuring a band of full-width rows through the
 * subject also measures the background either side of it, which is
 * blurred by design -- that reads as the subject going soft when it has
 * not.
 */
function contrast(data: Uint8ClampedArray, w: number,
                  x0: number, x1: number, y0: number, y1: number) {
  let total = 0, n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x += 1) {
      const i = (y * w + x) * 4;
      total += Math.abs(data[i]! - data[i - 4]!);
      n += 1;
    }
  }
  return n ? total / n : 0;
}

describe('finding the focal plane', () => {
  it('focuses on the subject, not on the nearest thing', () => {
    const { depth, mask } = scene();
    const plane = focalPlane(depth, mask);
    // The subject sits at 140/255; the table at 240/255.
    expect(plane).toBeGreaterThan(0.45);
    expect(plane).toBeLessThan(0.65);
  });

  it('says so when there is no subject to focus on', () => {
    const { depth } = scene();
    expect(focalPlane(depth, new Uint8ClampedArray(depth.length))).toBe(-1);
  });
});

describe('what gets blurred', () => {
  it('leaves the subject alone and defocuses both sides of it', () => {
    const { depth, mask, w, h } = scene();
    const field = blurField(depth, mask, focalPlane(depth, mask), w, h);
    const at = (x: number, y: number) => field[y * w + x]!;
    expect(at(w / 2, h * 0.5)).toBeLessThan(0.05);   // the subject
    expect(at(2, 2)).toBeGreaterThan(0.3);           // far background
    expect(at(2, h - 2)).toBeGreaterThan(0.3);       // near foreground
  });

  it('does nothing at all without a focal plane', () => {
    const { depth, mask, w, h } = scene();
    const field = blurField(depth, mask, -1, w, h);
    expect(field.every((v) => v === 0)).toBe(true);
  });
});

describe('applying the lens', () => {
  it('softens the background and keeps the subject sharp', () => {
    const s = scene();
    // The subject box, and a band of background well clear of it.
    const subjectBox = [Math.floor(s.w * 0.3), Math.floor(s.w * 0.7),
      Math.floor(s.h * 0.45), Math.floor(s.h * 0.6)] as const;
    const bgBox = [1, s.w - 1, 1, Math.floor(s.h * 0.25)] as const;
    const before = {
      subject: contrast(s.img, s.w, ...subjectBox),
      background: contrast(s.img, s.w, ...bgBox),
    };
    const field = blurField(s.depth, s.mask, focalPlane(s.depth, s.mask), s.w, s.h);
    applyFocus(s.img, s.w, s.h, field);
    const after = {
      subject: contrast(s.img, s.w, ...subjectBox),
      background: contrast(s.img, s.w, ...bgBox),
    };
    expect(after.background).toBeLessThan(before.background * 0.6);
    expect(after.subject).toBeGreaterThan(before.subject * 0.7);
  });

  it('invents nothing: every pixel stays inside the range it came from', () => {
    const s = scene();
    const field = blurField(s.depth, s.mask, focalPlane(s.depth, s.mask), s.w, s.h);
    applyFocus(s.img, s.w, s.h, field);
    for (let i = 0; i < s.img.length; i += 4) {
      expect(s.img[i]!).toBeGreaterThanOrEqual(30);
      expect(s.img[i]!).toBeLessThanOrEqual(220);
    }
  });

  it('leaves the alpha channel alone', () => {
    const s = scene();
    const field = blurField(s.depth, s.mask, focalPlane(s.depth, s.mask), s.w, s.h);
    applyFocus(s.img, s.w, s.h, field);
    for (let i = 3; i < s.img.length; i += 4) expect(s.img[i]).toBe(255);
  });

  it('approximates a lens in a fixed number of steps', () => {
    expect(LENS_STEPS).toBeGreaterThanOrEqual(3);
  });
});
