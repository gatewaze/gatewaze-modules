import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGREE_MARGIN,
  MAX_FAR_INSIDE,
  MAX_NEAR_OUTSIDE,
  PLATE_MIN_CHANGE,
  depthVerdict,
  layerAgreementScore,
  plateChangeScore,
} from '../depth-quality.js';

/** RGBA pixels: `luma` for the colour channels, `alpha` for the mask. */
function px(values: Array<{ luma?: number; alpha?: number }>): number[] {
  return values.flatMap(({ luma = 0, alpha = 255 }) => [luma, luma, luma, alpha]);
}
const repeat = <T,>(n: number, v: T) => Array.from({ length: n }, () => v);

describe('plateChangeScore', () => {
  it('is zero when the plate is the photo unchanged -- the people were never removed', () => {
    const photo = px(repeat(100, { luma: 120 }));
    const mask = px(repeat(100, { alpha: 255 }));
    expect(plateChangeScore(photo, photo, mask, 100)).toBe(0);
  });

  it('measures the change inside the mask only', () => {
    const photo = px([...repeat(80, { luma: 100 }), ...repeat(20, { luma: 100 })]);
    const plate = px([...repeat(80, { luma: 160 }), ...repeat(20, { luma: 0 })]);
    const mask = px([...repeat(80, { alpha: 255 }), ...repeat(20, { alpha: 0 })]);
    expect(plateChangeScore(photo, plate, mask, 100)).toBeCloseTo(60, 5);
  });

  it('does not flatten a photo on too little evidence', () => {
    const mask = px(repeat(100, { alpha: 0 }));
    expect(plateChangeScore(mask, mask, mask, 100)).toBe(255);
  });
});

describe('layerAgreementScore', () => {
  it('finds nothing wrong when near things are inside and far things outside', () => {
    const depth = px([...repeat(100, { luma: 200 }), ...repeat(100, { luma: 50 })]);
    const mask = px([...repeat(100, { alpha: 255 }), ...repeat(100, { alpha: 0 })]);
    expect(layerAgreementScore(depth, mask, 200)).toEqual({ nearOutside: 0, farInside: 0 });
  });

  // The pint glasses: as near as the people, but left out of the cutout.
  it('flags near things left outside the cutout', () => {
    const depth = px([...repeat(100, { luma: 200 }), ...repeat(100, { luma: 200 })]);
    const mask = px([...repeat(100, { alpha: 255 }), ...repeat(100, { alpha: 0 })]);
    expect(layerAgreementScore(depth, mask, 200).nearOutside).toBeCloseTo(0.5, 5);
  });

  // People at the back of the room taken into the cutout.
  it('flags far things taken inside the cutout', () => {
    const depth = px([...repeat(70, { luma: 220 }), ...repeat(30, { luma: 60 }), ...repeat(100, { luma: 40 })]);
    const mask = px([...repeat(100, { alpha: 255 }), ...repeat(100, { alpha: 0 })]);
    expect(layerAgreementScore(depth, mask, 200).farInside).toBeCloseTo(0.3, 5);
  });
});

describe('depthVerdict', () => {
  const good = {
    hasPlate: true, hasCutout: true, hasDepth: true,
    plateChange: 60, agreement: { nearOutside: 0, farInside: 0 },
  };

  it('allows parallax only when every check passes', () => {
    expect(depthVerdict(good)).toEqual({ parallax: true, reasons: [] });
  });

  // A missing depth map once let a broken photo keep its parallax.
  it('treats a missing depth map as a failure, not a pass', () => {
    const v = depthVerdict({ ...good, hasDepth: false, agreement: null });
    expect(v.parallax).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/no depth map/i);
  });

  it('explains each failure in words', () => {
    const v = depthVerdict({ ...good, plateChange: 10, agreement: { nearOutside: 0.2, farInside: 0.2 } });
    expect(v.parallax).toBe(false);
    expect(v.reasons).toHaveLength(3);
  });

  it('refuses missing layers', () => {
    expect(depthVerdict({ ...good, hasPlate: false }).parallax).toBe(false);
  });
});

/**
 * The projector keeps its own copy of this arithmetic rather than
 * importing it (see the header of depth-quality.ts). If a threshold is
 * tuned in one place and not the other, the admin would report a verdict
 * the projector does not act on. This fails when they differ.
 */
describe('the projector uses the same thresholds', () => {
  const src = readFileSync(
    join(__dirname, '../../portal/event-pages/_components/CinematicPhoto.tsx'), 'utf8',
  );
  const constant = (name: string) => {
    const m = new RegExp(`const ${name} = ([0-9.]+)`).exec(src);
    return m ? Number(m[1]) : NaN;
  };

  it.each([
    ['PLATE_MIN_CHANGE', PLATE_MIN_CHANGE],
    ['AGREE_MARGIN', AGREE_MARGIN],
    ['MAX_NEAR_OUTSIDE', MAX_NEAR_OUTSIDE],
    ['MAX_FAR_INSIDE', MAX_FAR_INSIDE],
  ])('%s matches', (name, value) => {
    expect(constant(name)).toBe(value);
  });
});
