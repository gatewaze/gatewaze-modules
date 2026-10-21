/**
 * The pixel arithmetic, on hand-made buffers.
 */

import { describe, it, expect } from 'vitest';
import {
  regionMean, sharpness, whiteFraction, alphaBounds, maskBounds, maskArea, meanLuma, glareFraction, screenFraction, gammaFor, frameStats,
} from '../lib/studio-pixels.js';

function gray(w: number, h: number, fill: (x: number, y: number) => number): Buffer {
  const b = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b[y * w + x] = fill(x, y);
  return b;
}

function rgba(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): Buffer {
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, bl, a] = fill(x, y);
    b.set([r, g, bl, a], (y * w + x) * 4);
  }
  return b;
}

describe('gray frames', () => {
  it('regionMean averages a clipped rectangle', () => {
    const g = gray(10, 10, (x) => (x < 5 ? 0 : 200));
    expect(regionMean(g, 10, 10, 5, 0, 5, 10)).toBe(200);
    expect(regionMean(g, 10, 10, 0, 0, 10, 10)).toBe(100);
    expect(regionMean(g, 10, 10, 8, 8, 10, 10)).toBe(200);
    expect(regionMean(g, 10, 10, 20, 20, 2, 2)).toBe(0);
  });
  it('sharpness is zero on a flat frame and high on a checkerboard', () => {
    expect(sharpness(gray(20, 20, () => 100), 20, 20)).toBe(0);
    expect(sharpness(gray(20, 20, (x, y) => ((x + y) % 2 ? 255 : 0)), 20, 20)).toBeGreaterThan(200);
  });
  it('whiteFraction counts near-white pixels', () => {
    expect(whiteFraction(gray(10, 10, (x) => (x < 5 ? 255 : 0)), 235, 1)).toBeCloseTo(0.5);
  });
  it('frameStats reads the sponsor strip region at any contact size', () => {
    const st = frameStats(gray(640, 360, (_, y) => (y >= 295 ? 230 : 20)), 640, 360);
    expect(st.bottom).toBeGreaterThan(190);
    expect(st.mean).toBeLessThan(100);
  });
});

describe('cut-outs', () => {
  it('alphaBounds and maskBounds find the figure', () => {
    const a = rgba(40, 40, (x, y) => [100, 100, 100, x >= 10 && x < 30 && y >= 5 && y < 35 ? 255 : 0]);
    expect(alphaBounds(a, 40, 40)).toEqual({ x0: 10, y0: 6, x1: 29, y1: 35 });
    expect(alphaBounds(rgba(8, 8, () => [0, 0, 0, 0]), 8, 8)).toBeNull();
    const m = gray(40, 40, (x) => (x >= 20 ? 255 : 0));
    expect(maskBounds(m, 40, 40)?.x0).toBe(20);
    expect(maskArea(m, 1)).toBe(800);
  });
  it('meanLuma reads only opaque pixels', () => {
    const a = rgba(10, 10, (x) => (x < 5 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    expect(meanLuma(a, 1)).toBeCloseTo(255, 0);
  });
  it('glareFraction measures the head band of the figure', () => {
    // A 100-tall figure whose top 30 rows are blown out.
    const a = rgba(50, 120, (x, y) => (x >= 10 && x < 40 && y >= 10 && y < 110 ? (y < 40 ? [255, 255, 255, 255] : [60, 60, 60, 255]) : [0, 0, 0, 0]));
    expect(glareFraction(a, 50, { x0: 10, y0: 10, x1: 40, y1: 110 })).toBeCloseTo(1, 1);
    const clean = rgba(50, 120, (x, y) => (x >= 10 && x < 40 && y >= 10 && y < 110 ? [60, 60, 60, 255] : [0, 0, 0, 0]));
    expect(glareFraction(clean, 50, { x0: 10, y0: 10, x1: 40, y1: 110 })).toBe(0);
  });
  it('screenFraction looks at the background around the head, not the figure', () => {
    const W = 200; const H = 120;
    const bb = { x0: 80, y0: 10, x1: 120, y1: 110 };
    const cut = rgba(W, H, (x, y) => (x >= 80 && x < 120 && y >= 10 && y < 110 ? [50, 50, 50, 255] : [0, 0, 0, 0]));
    const whiteBg = Buffer.alloc(W * H * 3, 250);
    const darkBg = Buffer.alloc(W * H * 3, 20);
    expect(screenFraction(whiteBg, cut, W, H, bb)).toBeGreaterThan(0.9);
    expect(screenFraction(darkBg, cut, W, H, bb)).toBe(0);
  });
  it('gammaFor lifts darker cut-outs more', () => {
    expect(gammaFor(20)).toBe(1.55);
    expect(gammaFor(45)).toBe(1.3);
    expect(gammaFor(60)).toBe(1.12);
    expect(gammaFor(90)).toBe(1);
  });
});
