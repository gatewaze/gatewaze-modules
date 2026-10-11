import { describe, it, expect } from 'vitest';
import { denoise, noiseLevel } from '../denoise.js';

/** A flat field with colour speckle and an edge down the middle. */
function noisy(w = 48, h = 48, chroma = 40, luma = 6) {
  const d = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const base = x < w / 2 ? 70 : 170;      // a real edge
      const l = base + rnd() * luma;
      d[i] = l + rnd() * chroma;
      d[i + 1] = l;
      d[i + 2] = l + rnd() * chroma;
      d[i + 3] = 255;
    }
  }
  return { d, w, h };
}

/** How much the colour channels wander away from brightness. */
function speckle(data: Uint8ClampedArray) {
  let total = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    total += Math.abs(data[i]! - y) + Math.abs(data[i + 2]! - y);
    n += 1;
  }
  return n ? total / n : 0;
}

/** Contrast across the edge in the middle. */
function edge(data: Uint8ClampedArray, w: number, h: number) {
  const y = Math.floor(h / 2);
  const left = data[(y * w + Math.floor(w / 2) - 3) * 4]!;
  const right = data[(y * w + Math.floor(w / 2) + 3) * 4]!;
  return Math.abs(right - left);
}

describe('measuring noise', () => {
  it('reads a grainy photograph as noisier than a clean one', () => {
    const grainy = noisy(48, 48, 40, 14);
    const clean = noisy(48, 48, 0, 0);
    expect(noiseLevel(grainy.d, 48, 48)).toBeGreaterThan(noiseLevel(clean.d, 48, 48));
  });

  it('has no opinion on something too small to measure', () => {
    expect(noiseLevel(new Uint8ClampedArray(16), 2, 2)).toBe(0);
  });
});

describe('cleaning it', () => {
  it('takes the colour speckle out', () => {
    const { d, w, h } = noisy();
    const was = speckle(d);
    denoise(d, w, h, 1);
    expect(speckle(d)).toBeLessThan(was * 0.5);
  });

  it('keeps the edge', () => {
    const { d, w, h } = noisy();
    const was = edge(d, w, h);
    denoise(d, w, h, 1);
    // Chroma goes; the edge is brightness, and brightness survives.
    expect(edge(d, w, h)).toBeGreaterThan(was * 0.8);
  });

  it('does nothing when asked for nothing', () => {
    const { d, w, h } = noisy();
    const copy = Uint8ClampedArray.from(d);
    denoise(d, w, h, 0);
    expect([...d]).toEqual([...copy]);
  });

  it('leaves the alpha channel alone', () => {
    const { d, w, h } = noisy();
    denoise(d, w, h, 1);
    for (let i = 3; i < d.length; i += 4) expect(d[i]).toBe(255);
  });
});
