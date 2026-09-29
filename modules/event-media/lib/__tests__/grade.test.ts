import { describe, it, expect } from 'vitest';
import { applyOps } from '../enhance.js';
import { HOUSE, gradeFor, profileOf, type ToneProfile } from '../grade.js';

/** An image with a black end, a mid tone and a highlight, in a given colour. */
function scene(dark: number, mid: number, light: number, tint = { r: 1, g: 1, b: 1 }) {
  const d = new Uint8ClampedArray(300 * 4);
  for (let i = 0; i < d.length; i += 4) {
    const third = Math.floor(i / 4) % 3;
    const v = third === 0 ? dark : third === 1 ? mid : light;
    d[i] = v * tint.r; d[i + 1] = v * tint.g; d[i + 2] = v * tint.b; d[i + 3] = 255;
  }
  return d;
}

describe('measuring a photograph for grading', () => {
  it('reads its tones apart', () => {
    const p = profileOf(scene(10, 120, 240));
    expect(p.p5).toBeLessThan(20);
    expect(p.p95).toBeGreaterThan(200);
    expect(p.mean).toBeGreaterThan(100);
    expect(p.mean).toBeLessThan(140);
  });

  it('reads a colour cast as a ratio to green', () => {
    const warm = profileOf(scene(20, 120, 220, { r: 1.2, g: 1, b: 0.8 }));
    expect(warm.rg).toBeGreaterThan(1.1);
    expect(warm.bg).toBeLessThan(0.95);
  });

  it('reads grey as having no colour in it', () => {
    expect(profileOf(scene(30, 128, 220)).sat).toBeLessThan(0.02);
  });

  it('falls back to the reference rather than dividing by nothing', () => {
    expect(profileOf(new Uint8ClampedArray(0))).toEqual(HOUSE);
  });
});

describe('carrying a photograph towards the reference', () => {
  /** What a photograph measures once the grade has been applied to it. */
  const graded = (data: Uint8ClampedArray): ToneProfile => {
    const copy = new Uint8ClampedArray(data);
    applyOps(copy, 10, 30, gradeFor(profileOf(copy)));
    return profileOf(copy);
  };

  // The fault reported on 2026-09-29: the relit copies carried two and a
  // half times the saturation of real professional photographs.
  it('takes colour out of an over-saturated photograph', () => {
    const loud = scene(20, 110, 210, { r: 1.35, g: 0.85, b: 0.6 });
    const was = profileOf(loud);
    const now = graded(loud);
    expect(was.sat).toBeGreaterThan(HOUSE.sat * 1.8);
    expect(now.sat).toBeLessThan(was.sat);
    expect(now.sat).toBeLessThan(HOUSE.sat * 1.6);
  });

  it('pulls a warm cast back towards neutral', () => {
    const warm = scene(20, 120, 220, { r: 1.25, g: 1, b: 0.78 });
    const was = profileOf(warm);
    const now = graded(warm);
    expect(Math.abs(now.rg - HOUSE.rg)).toBeLessThan(Math.abs(was.rg - HOUSE.rg));
    expect(Math.abs(now.bg - HOUSE.bg)).toBeLessThan(Math.abs(was.bg - HOUSE.bg));
  });

  it('opens up a flat, dark photograph', () => {
    const flat = scene(15, 60, 105);
    const now = graded(flat);
    expect(now.mean).toBeGreaterThan(profileOf(flat).mean);
    expect(now.p95).toBeGreaterThan(profileOf(flat).p95);
  });

  // The whole point of a reference is that a photograph already at it is
  // left alone -- verified against the real set, which moved from a mean
  // of 161.4 to 160.5 and a saturation of 0.175 to 0.185.
  it('barely touches a photograph already at the reference', () => {
    const ops = gradeFor({ ...HOUSE });
    expect(ops.linear.multiplier).toBeCloseTo(1, 1);
    expect(ops.modulate.saturation).toBeCloseTo(1, 1);
    expect(ops.tint.red).toBeCloseTo(1, 2);
    expect(ops.tint.blue).toBeCloseTo(1, 2);
  });

  it('stays a grade, however far off the photograph is', () => {
    for (const p of [
      { ...HOUSE, p5: 0, p95: 5, sat: 0.99, rg: 2.5, bg: 0.2 },
      { ...HOUSE, p5: 250, p95: 255, sat: 0.001, rg: 0.3, bg: 3 },
    ]) {
      const ops = gradeFor(p);
      expect(ops.linear.multiplier).toBeGreaterThanOrEqual(0.8);
      expect(ops.linear.multiplier).toBeLessThanOrEqual(2.0);
      expect(ops.modulate.saturation).toBeGreaterThanOrEqual(0.45);
      expect(ops.modulate.saturation).toBeLessThanOrEqual(1.3);
      expect(ops.tint.red).toBeGreaterThanOrEqual(0.85);
      expect(ops.tint.red).toBeLessThanOrEqual(1.2);
    }
  });

  it('never sharpens: a grade is colour and tone only', () => {
    expect(gradeFor(profileOf(scene(10, 90, 200))).sharpenSigma).toBe(0);
    expect(gradeFor(profileOf(scene(10, 90, 200))).modulate.brightness).toBe(1);
  });
});
