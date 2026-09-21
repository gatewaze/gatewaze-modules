// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { coverCrop, pctStyle, stageRect } from '../event-pages/_components/_lib/booth-stage.js';

describe('stageRect', () => {
  // iPhone 14: 390x844, painting 941x1672.
  it('fills a phone\'s height and crops the side away from the focus', () => {
    const r = stageRect(390, 844, 941, 1672, 0.85);
    expect(r.height).toBe(844);
    expect(r.width).toBeCloseTo(475, 0);
    const overflow = r.width - 390;
    expect(r.left).toBeCloseTo(-overflow * 0.85, 5);
    // The right-hand edge of the board's tiles (x=857/941) stays on screen.
    expect(r.left + r.width * (857 / 941)).toBeLessThanOrEqual(390);
  });

  it('centres when the focus is the middle', () => {
    const r = stageRect(390, 844, 941, 1672, 0.5);
    expect(r.left + r.width / 2).toBeCloseTo(195, 5);
  });

  // A laptop is wider than the painting: nothing is cropped at all.
  it('shows the whole painting, centred, on a wide screen', () => {
    const r = stageRect(1440, 900, 941, 1672, 0.85);
    expect(r.height).toBe(900);
    expect(r.left).toBeCloseTo((1440 - r.width) / 2, 5);
    expect(r.left).toBeGreaterThan(0);
  });

  it('clamps a focus outside 0..1', () => {
    expect(stageRect(390, 844, 941, 1672, 7).left).toBeCloseTo(stageRect(390, 844, 941, 1672, 1).left, 5);
  });
});

describe('coverCrop', () => {
  it('trims the sides of a landscape frame for a portrait window', () => {
    const c = coverCrop(1280, 720, 0.75);
    expect(c.sh).toBe(720);
    expect(c.sw).toBeCloseTo(540, 5);
    expect(c.sx).toBeCloseTo((1280 - 540) / 2, 5);
    expect(c.sy).toBe(0);
  });

  it('trims top and bottom of a tall frame for a squarer window', () => {
    const c = coverCrop(720, 1280, 1);
    expect(c.sw).toBe(720);
    expect(c.sh).toBe(720);
    expect(c.sy).toBe(280);
  });

  it('keeps the whole frame when there is nothing to go on', () => {
    expect(coverCrop(0, 0, 1)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 });
    expect(coverCrop(100, 50, NaN)).toEqual({ sx: 0, sy: 0, sw: 100, sh: 50 });
  });
});

describe('pctStyle', () => {
  it('turns fractions into percentages', () => {
    expect(pctStyle({ x: 0.1, y: 0.25, w: 0.5, h: 0.125 })).toEqual({
      left: '10.000%', top: '25.000%', width: '50.000%', height: '12.500%',
    });
  });
});
