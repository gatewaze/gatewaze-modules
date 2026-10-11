import { describe, it, expect } from 'vitest';
import { CLASSIC, classicFor, cropTo, expandTo, lossFrom, worthReframing } from '../framing.js';

describe('choosing the shape', () => {
  it('keeps a portrait portrait and a landscape landscape', () => {
    expect(classicFor(3000, 4000)).toBe(CLASSIC.portrait);
    expect(classicFor(4000, 3000)).toBe(CLASSIC.landscape);
  });

  it('leaves a square alone', () => {
    expect(classicFor(1000, 1000)).toBe(CLASSIC.square);
    expect(classicFor(1000, 1020)).toBe(CLASSIC.square);
  });

  it('answers something sane for nonsense', () => {
    expect(classicFor(0, 0)).toBe(CLASSIC.landscape);
  });
});

describe('cropping to the shape', () => {
  // The guests' commonest frame: a phone's 3:4 portrait.
  it('takes a ninth off the width of a phone portrait', () => {
    const box = cropTo(3000, 4000, CLASSIC.portrait);
    expect(box.h).toBe(4000);
    expect(box.w).toBe(Math.round(4000 * (2 / 3)));
    // Centred, so the same is lost from each side.
    expect(box.x).toBe(Math.round((3000 - box.w) / 2));
    expect(lossFrom(3000, 4000, CLASSIC.portrait)).toBeCloseTo(0.111, 2);
  });

  it('takes height off a phone landscape, mostly from the bottom', () => {
    const box = cropTo(4000, 3000, CLASSIC.landscape);
    expect(box.w).toBe(4000);
    expect(box.h).toBe(Math.round(4000 / (3 / 2)));
    // Heads are in the top half: less comes off the top than the bottom.
    const fromTop = box.y;
    const fromBottom = 3000 - box.h - box.y;
    expect(fromTop).toBeLessThan(fromBottom);
  });

  it('does nothing to a frame already the right shape', () => {
    expect(cropTo(3000, 2000, CLASSIC.landscape)).toEqual({ x: 0, y: 0, w: 3000, h: 2000 });
    expect(lossFrom(3000, 2000, CLASSIC.landscape)).toBe(0);
  });

  it('always returns a box inside the photograph', () => {
    for (const [w, h] of [[4000, 3000], [3000, 4000], [1000, 1000], [5000, 1200], [900, 4000]]) {
      for (const r of [CLASSIC.landscape, CLASSIC.portrait, CLASSIC.square]) {
        const b = cropTo(w!, h!, r);
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(w!);
        expect(b.y + b.h).toBeLessThanOrEqual(h!);
        expect(b.w / b.h).toBeCloseTo(r, 1);
      }
    }
  });
});

describe('expanding to the shape instead', () => {
  // Cropping a 3:4 to 2:3 makes it narrower; expanding instead makes it
  // taller. Same shape at the end, nothing thrown away.
  it('keeps every pixel and adds the difference outside', () => {
    const { box, at } = expandTo(3000, 4000, CLASSIC.portrait);
    expect(box.w).toBe(3000);
    expect(box.h).toBe(4500);
    expect(at.x).toBe(0);
    expect(at.y).toBe(Math.round((4500 - 4000) / 2));
  });

  it('grows a phone landscape sideways', () => {
    const { box, at } = expandTo(4000, 3000, CLASSIC.landscape);
    expect(box.h).toBe(3000);
    expect(box.w).toBe(4500);
    expect(at.y).toBe(0);
    expect(at.x).toBe(Math.round((4500 - 4000) / 2));
  });

  // The whole point: everything the model is asked to draw is outside
  // the photograph, so laying the original back over the result cannot
  // leave a generated pixel anywhere near a face.
  it('adds only what was never photographed', () => {
    const { box, at } = expandTo(3000, 4000, CLASSIC.portrait);
    const added = box.w * box.h - 3000 * 4000;
    expect(added).toBeGreaterThan(0);
    expect(at.x).toBeGreaterThanOrEqual(0);
    expect(at.y).toBeGreaterThanOrEqual(0);
  });

  it('always contains the original, wholly', () => {
    for (const [w, h] of [[4000, 3000], [3000, 4000], [1000, 1000], [4000, 1000]]) {
      for (const r of [CLASSIC.landscape, CLASSIC.portrait]) {
        const { box, at } = expandTo(w!, h!, r);
        expect(box.w).toBeGreaterThanOrEqual(w!);
        expect(box.h).toBeGreaterThanOrEqual(h!);
        expect(at.x + w!).toBeLessThanOrEqual(box.w);
        expect(at.y + h!).toBeLessThanOrEqual(box.h);
      }
    }
  });

  it('does nothing to a frame already the right shape', () => {
    const { box, at } = expandTo(3000, 2000, CLASSIC.landscape);
    expect(box).toEqual({ x: 0, y: 0, w: 3000, h: 2000 });
    expect(at).toEqual({ x: 0, y: 0 });
  });
});

describe('deciding whether to bother', () => {
  it('reshapes an ordinary phone frame', () => {
    expect(worthReframing(3000, 4000, CLASSIC.portrait)).toBe(true);
    expect(worthReframing(4000, 3000, CLASSIC.landscape)).toBe(true);
  });

  it('leaves a frame that is already close', () => {
    expect(worthReframing(3000, 2000, CLASSIC.landscape)).toBe(false);
    expect(worthReframing(3000, 2010, CLASSIC.landscape)).toBe(false);
  });

  // A panorama is a panorama and a square was somebody's decision.
  it('refuses to take a quarter of a photograph away', () => {
    expect(worthReframing(6000, 1200, CLASSIC.landscape)).toBe(false);
    expect(worthReframing(1000, 1000, CLASSIC.portrait)).toBe(false);
  });
});
