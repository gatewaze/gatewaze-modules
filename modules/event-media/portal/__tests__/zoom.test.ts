import { describe, it, expect } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  NO_ZOOM,
  clampPan,
  clampScale,
  isDoubleTap,
  isZoomed,
  midpoint,
  scaleAbout,
  settle,
  spread,
} from '../event-pages/_components/_lib/zoom';

const FRAME = { w: 400, h: 800 };
const CONTENT = { w: 400, h: 300 };

describe('clampScale', () => {
  it('never shrinks below the frame and never runs away', () => {
    expect(clampScale(0.2)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(2.5)).toBe(2.5);
  });

  // A degenerate pinch -- two fingers landing on the same pixel, so the
  // spread is zero and the ratio blows up -- comes back to fit rather
  // than to maximum. Fit is the recoverable state: the viewer sees the
  // photograph as it was and can try again, where being thrown to 6x
  // leaves them lost in a corner of it.
  it('comes back to fit on a number that is not one', () => {
    expect(clampScale(NaN)).toBe(MIN_SCALE);
    expect(clampScale(Infinity)).toBe(MIN_SCALE);
    expect(clampScale(-Infinity)).toBe(MIN_SCALE);
    // A real number out of range is still clamped to the range.
    expect(clampScale(1e6)).toBe(MAX_SCALE);
  });
});

describe('spread and midpoint', () => {
  it('measure between two fingers', () => {
    expect(spread({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
  });

  it('gives zero rather than a NaN that would poison the transform', () => {
    expect(spread({ x: NaN, y: 0 }, { x: 0, y: 0 })).toBe(0);
  });
});

describe('scaleAbout', () => {
  // Zooming about the centre of the frame rather than the centre of the
  // fingers is what makes a pinch feel like it is fighting you.
  it('keeps whatever is under the fingers under the fingers', () => {
    const at = { x: 100, y: -50 };
    const z = scaleAbout(at, NO_ZOOM, 2);
    // The content point under `at` before was (at - 0) / 1 = at.
    // After, it must still appear at `at`: at = c * 2 + t.
    expect(at.x).toBeCloseTo(at.x * z.scale + z.x, 6);
    expect(at.y).toBeCloseTo(at.y * z.scale + z.y, 6);
  });

  it('holds the anchor across a second pinch from an offset state', () => {
    const start = { scale: 2, x: 30, y: -10 };
    const at = { x: -60, y: 40 };
    const before = { x: (at.x - start.x) / start.scale, y: (at.y - start.y) / start.scale };
    const z = scaleAbout(at, start, 3.5);
    expect(before.x * z.scale + z.x).toBeCloseTo(at.x, 6);
    expect(before.y * z.scale + z.y).toBeCloseTo(at.y, 6);
  });

  it('about the centre, an offset-free zoom stays offset-free', () => {
    const z = scaleAbout({ x: 0, y: 0 }, NO_ZOOM, 3);
    expect(z).toEqual({ scale: 3, x: 0, y: 0 });
  });

  it('clamps the scale it is asked for', () => {
    expect(scaleAbout({ x: 10, y: 10 }, NO_ZOOM, 1000).scale).toBe(MAX_SCALE);
    expect(scaleAbout({ x: 10, y: 10 }, NO_ZOOM, 0.1).scale).toBe(MIN_SCALE);
  });

  it('survives a zero scale rather than dividing by it', () => {
    const z = scaleAbout({ x: 5, y: 5 }, { scale: 0, x: 0, y: 0 }, 2);
    expect(Number.isFinite(z.x)).toBe(true);
    expect(Number.isFinite(z.y)).toBe(true);
  });
});

describe('clampPan', () => {
  // An axis that already fits is pinned: letting a photograph that fits
  // wander around the screen is the other half of a broken zoom.
  it('pins an axis with nothing to spare', () => {
    // Content 400x300 at scale 1 in a 400x800 frame: neither axis overhangs.
    const z = clampPan({ scale: 1, x: 120, y: -90 }, FRAME, CONTENT);
    expect(z).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('allows exactly half the overhang, and not a pixel more', () => {
    // At scale 2 the content is 800x600. Overhang: x 400, y 0 (frame is 800 tall).
    const z = clampPan({ scale: 2, x: 999, y: 999 }, FRAME, CONTENT);
    expect(z.x).toBe(200);
    expect(z.y).toBe(0);
    expect(clampPan({ scale: 2, x: -999, y: 0 }, FRAME, CONTENT).x).toBe(-200);
  });

  it('leaves a legal offset alone', () => {
    expect(clampPan({ scale: 2, x: 50, y: 0 }, FRAME, CONTENT).x).toBe(50);
  });

  it('is not fooled by nonsense', () => {
    const z = clampPan({ scale: 2, x: NaN, y: NaN }, FRAME, CONTENT);
    expect(z.x).toBe(0);
    expect(z.y).toBe(0);
    expect(clampPan({ scale: 2, x: 10, y: 0 }, { w: NaN, h: NaN }, CONTENT).x).toBe(0);
  });
});

describe('settle', () => {
  it('returns to fit once the fingers let go of a shrink', () => {
    expect(settle({ scale: 1, x: 80, y: 80 }, FRAME, CONTENT)).toEqual(NO_ZOOM);
    expect(settle({ scale: 0.4, x: 80, y: 80 }, FRAME, CONTENT)).toEqual(NO_ZOOM);
  });

  it('keeps a real zoom, within bounds', () => {
    const z = settle({ scale: 2, x: 999, y: 0 }, FRAME, CONTENT);
    expect(z.scale).toBe(2);
    expect(z.x).toBe(200);
  });
});

describe('isZoomed', () => {
  it('ignores the floating-point dust a pinch leaves behind', () => {
    expect(isZoomed(NO_ZOOM)).toBe(false);
    expect(isZoomed({ scale: 1.001, x: 0, y: 0 })).toBe(false);
    expect(isZoomed({ scale: 1.4, x: 0, y: 0 })).toBe(true);
  });
});

describe('isDoubleTap', () => {
  const first = { at: 1_000, x: 100, y: 100 };

  it('takes two quick taps in the same place', () => {
    expect(isDoubleTap(first, { at: 1_150, x: 105, y: 98 })).toBe(true);
  });

  it('refuses two taps too far apart in time', () => {
    expect(isDoubleTap(first, { at: 1_800, x: 100, y: 100 })).toBe(false);
  });

  // Two taps in quick succession at opposite corners are two taps.
  it('refuses two taps too far apart on screen', () => {
    expect(isDoubleTap(first, { at: 1_100, x: 320, y: 100 })).toBe(false);
  });

  it('refuses the first tap of the session', () => {
    expect(isDoubleTap(null, { at: 1_000, x: 0, y: 0 })).toBe(false);
  });

  it('refuses a clock that went backwards', () => {
    expect(isDoubleTap(first, { at: 900, x: 100, y: 100 })).toBe(false);
  });
});
