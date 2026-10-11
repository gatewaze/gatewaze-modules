import { describe, it, expect } from 'vitest';
import { CURVE_POINTS, HOUSE, applyGrade, applyMono, gradeFor, profileOf } from '../grade.js';

/** An image with a black end, a mid tone and a highlight, in a given colour. */
function scene(dark: number, mid: number, light: number, tint = { r: 1, g: 1, b: 1 }, w = 30, h = 30) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) {
    const third = Math.floor(i / 4) % 3;
    const v = third === 0 ? dark : third === 1 ? mid : light;
    d[i] = v * tint.r; d[i + 1] = v * tint.g; d[i + 2] = v * tint.b; d[i + 3] = 255;
  }
  return { data: d, w, h };
}

describe('measuring a photograph', () => {
  it('describes the tone curve at nine points, rising', () => {
    const p = profileOf(scene(10, 120, 240).data);
    expect(p.curve).toHaveLength(CURVE_POINTS);
    for (let i = 1; i < p.curve.length; i += 1) {
      expect(p.curve[i]!).toBeGreaterThanOrEqual(p.curve[i - 1]!);
    }
  });

  it('reads the shadows and the highlights apart', () => {
    // Warm shadows, neutral highlights: the wedding's own fault.
    const w = 40, h = 40;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const v = 20 + (215 * (y * w + x)) / (w * h);
        const warm = Math.max(0, 1 - v / 110);
        const i = (y * w + x) * 4;
        d[i] = v * (1 + 0.6 * warm); d[i + 1] = v; d[i + 2] = v * (1 - 0.35 * warm); d[i + 3] = 255;
      }
    }
    const p = profileOf(d, w, h);
    expect(p.shadowWarm).toBeGreaterThan(1.3);
    expect(p.highWarm).toBeLessThan(p.shadowWarm);
  });

  // A flat photograph has no two ends to compare, so the split has to be
  // a no-op rather than a correction aimed at a number nobody measured.
  it('has no opinion on the ends of a flat photograph', () => {
    const flat = new Uint8ClampedArray(40 * 40 * 4).fill(255);
    for (let i = 0; i < flat.length; i += 4) { flat[i] = 120; flat[i + 1] = 120; flat[i + 2] = 120; }
    const p = profileOf(flat, 40, 40);
    // Both ends read the same number, because there is only one end.
    expect(p.shadowWarm).toBeCloseTo(p.highWarm, 3);
    // The two corrections still differ, and should: they aim at the
    // reference's shadow warmth and its highlight warmth, which are not
    // the same number either.
    const g = gradeFor(p);
    expect(g.split.shadow).toBeGreaterThanOrEqual(0.88);
    expect(g.split.shadow).toBeLessThanOrEqual(1.14);
    expect(g.split.highlight).toBeGreaterThanOrEqual(0.88);
    expect(g.split.highlight).toBeLessThanOrEqual(1.14);
  });

  it('sees a vignette only when it is given the shape of the frame', () => {
    const w = 60, h = 60;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const dx = (x - 30) / 30, dy = (y - 30) / 30;
        const v = 200 * (1 - 0.5 * (dx * dx + dy * dy));
        const i = (y * w + x) * 4;
        d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
      }
    }
    expect(profileOf(d, w, h).vignette).toBeLessThan(0.85);
    // Without the shape it has no opinion rather than a wrong one.
    expect(profileOf(d).vignette).toBe(1);
  });

  it('falls back to the reference rather than dividing by nothing', () => {
    expect(profileOf(new Uint8ClampedArray(0)).sat).toBe(HOUSE.sat);
  });
});

describe('carrying a photograph towards the reference', () => {
  const graded = (s: ReturnType<typeof scene>, ref = HOUSE) => {
    const copy = new Uint8ClampedArray(s.data);
    applyGrade(copy, s.w, s.h, gradeFor(profileOf(copy, s.w, s.h), ref));
    return profileOf(copy, s.w, s.h);
  };

  it('takes colour out of an over-saturated photograph', () => {
    const loud = scene(20, 110, 210, { r: 1.35, g: 0.85, b: 0.6 });
    const was = profileOf(loud.data, loud.w, loud.h);
    const now = graded(loud);
    expect(was.sat).toBeGreaterThan(HOUSE.sat * 1.5);
    expect(now.sat).toBeLessThan(was.sat);
  });

  // Re-measuring after a grade compares different pixels: the tone
  // curve moves the band, so the darkest fifth afterwards is a deeper,
  // warmer set than it was before. So this checks the correction itself
  // and one known pixel, rather than a statistic over a moving target.
  it('cools shadows that are warmer than the reference', () => {
    const w = 40, h = 40;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const v = 20 + (215 * (y * w + x)) / (w * h);
        const warm = Math.max(0, 1 - v / 110);
        const i = (y * w + x) * 4;
        d[i] = v * (1 + 0.6 * warm); d[i + 1] = v; d[i + 2] = v * (1 - 0.35 * warm); d[i + 3] = 255;
      }
    }
    const was = profileOf(d, w, h);
    expect(was.shadowWarm).toBeGreaterThan(HOUSE.shadowWarm);
    const g = gradeFor(was);
    // Warmer than the reference, so the shadows are cooled.
    expect(g.split.shadow).toBeLessThan(1);

    // And the split, on its own, cools a dark warm pixel. Isolated with
    // an identity curve: a per-channel tone curve moves colour ratios
    // too -- that is how a film curve tints -- so it would mask this.
    const identity = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v += 1) identity[v] = v;
    const one = new Uint8ClampedArray([70, 44, 28, 255]);
    const before = one[0]! / one[2]!;
    applyGrade(one, 1, 1, {
      lut: identity, tint: { red: 1, blue: 1 },
      split: { shadow: 0.9, highlight: 1 }, saturation: 1, vignette: 1,
    });
    expect(one[0]! / one[2]!).toBeLessThan(before);
  });

  it('darkens the corners when the reference has a vignette', () => {
    const flat = scene(120, 120, 120, { r: 1, g: 1, b: 1 }, 60, 60);
    const g = gradeFor(profileOf(flat.data, 60, 60));
    expect(g.vignette).toBeLessThan(1);
    applyGrade(flat.data, 60, 60, g);
    const corner = flat.data[0]!;
    const centre = flat.data[((30 * 60) + 30) * 4]!;
    expect(corner).toBeLessThan(centre);
  });

  it('keeps the tone curve monotonic, however odd the photograph', () => {
    for (const s of [scene(0, 0, 0), scene(255, 255, 255), scene(10, 11, 12)]) {
      const g = gradeFor(profileOf(s.data, s.w, s.h));
      for (let v = 1; v < 256; v += 1) {
        expect(g.lut[v]!).toBeGreaterThanOrEqual(g.lut[v - 1]!);
      }
    }
  });

  it('barely touches a photograph already at the reference', () => {
    const g = gradeFor({ ...HOUSE });
    expect(g.saturation).toBeCloseTo(1, 1);
    expect(g.tint.red).toBeCloseTo(1, 2);
    expect(g.split.shadow).toBeCloseTo(1, 2);
    expect(g.vignette).toBeCloseTo(1, 2);
  });

  it('stays a grade, however far off the photograph is', () => {
    const wild = { ...HOUSE, sat: 0.99, rg: 2.5, bg: 0.2, shadowWarm: 3, highWarm: 0.3, vignette: 1.6 };
    const g = gradeFor(wild);
    expect(g.saturation).toBeGreaterThanOrEqual(0.45);
    expect(g.saturation).toBeLessThanOrEqual(1.3);
    expect(g.tint.red).toBeGreaterThanOrEqual(0.85);
    expect(g.tint.red).toBeLessThanOrEqual(1.2);
    expect(g.split.shadow).toBeGreaterThanOrEqual(0.88);
    expect(g.vignette).toBeGreaterThanOrEqual(0.6);
    expect(g.vignette).toBeLessThanOrEqual(1.0);
  });
});

describe('black and white', () => {
  it('leaves every channel on the same value', () => {
    const s = scene(30, 120, 220, { r: 1.3, g: 1, b: 0.7 });
    applyMono(s.data);
    for (let i = 0; i < s.data.length; i += 4) {
      expect(s.data[i]).toBe(s.data[i + 1]);
      expect(s.data[i + 1]).toBe(s.data[i + 2]);
    }
    expect(profileOf(s.data, s.w, s.h).sat).toBeLessThan(0.02);
  });
});
