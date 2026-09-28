// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import {
  DARK_BELOW,
  DIM_BELOW,
  flashPlan,
  guidanceFor,
  hasSettled,
  liftFor,
  lightLevel,
  readFrame,
  regionLuma,
} from '../event-pages/_components/_lib/booth-light';

/** A frame of one brightness, with an optional brighter patch. */
function frame(w: number, h: number, value: number, patch?: { x: number; y: number; w: number; h: number; value: number }) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = value; d[i + 1] = value; d[i + 2] = value; d[i + 3] = 255; }
  if (patch) {
    for (let y = patch.y; y < patch.y + patch.h; y++) {
      for (let x = patch.x; x < patch.x + patch.w; x++) {
        const o = (y * w + x) * 4;
        d[o] = patch.value; d[o + 1] = patch.value; d[o + 2] = patch.value;
      }
    }
  }
  return d;
}

describe('reading how dark it is', () => {
  it('reads a flat frame as its own brightness', () => {
    expect(readFrame(frame(32, 32, 120), 32, 32).centre).toBeCloseTo(120, 0);
  });

  // A dim room with a bright doorway behind gives a respectable average
  // while the face is in shadow, and it is the face that matters.
  it('judges the middle, not the whole', () => {
    // Dark in the middle, bright around the edges.
    const d = frame(32, 32, 200, { x: 8, y: 6, w: 16, h: 20, value: 30 });
    const r = readFrame(d, 32, 32);
    expect(r.centre).toBeLessThan(60);
    expect(r.whole).toBeGreaterThan(100);
    expect(lightLevel(r)).toBe('dark');
  });

  it('is not dragged about by one bright thing in shot', () => {
    // A candle in the middle of an otherwise dark frame.
    const plain = regionLuma(frame(32, 32, 40), 32, 32, { x: 0, y: 0, w: 32, h: 32 });
    const withCandle = regionLuma(
      frame(32, 32, 40, { x: 15, y: 15, w: 2, h: 2, value: 255 }),
      32, 32, { x: 0, y: 0, w: 32, h: 32 },
    );
    expect(Math.abs(withCandle - plain)).toBeLessThan(1);
  });

  it('says nothing silly about an empty frame', () => {
    expect(regionLuma(new Uint8ClampedArray(0), 0, 0, { x: 0, y: 0, w: 0, h: 0 })).toBe(128);
  });
});

describe('how dark counts as dark', () => {
  it('holds the line where the constants say', () => {
    expect(lightLevel({ centre: DIM_BELOW, whole: 0 })).toBe('fine');
    expect(lightLevel({ centre: DIM_BELOW - 1, whole: 0 })).toBe('dim');
    expect(lightLevel({ centre: DARK_BELOW, whole: 0 })).toBe('dim');
    expect(lightLevel({ centre: DARK_BELOW - 1, whole: 0 })).toBe('dark');
  });
});

describe('whether to light the screen', () => {
  // The guard that has to hold: a flash nobody needed is worse than none.
  it('leaves a well-lit room alone', () => {
    const plan = flashPlan({ centre: 130, whole: 130 });
    expect(plan.on).toBe(false);
    expect(plan.alpha).toBe(0);
  });

  it('lights it for a dim room, and harder for a dark one', () => {
    const dim = flashPlan({ centre: 60, whole: 60 });
    const dark = flashPlan({ centre: 20, whole: 20 });
    expect(dim.on).toBe(true);
    expect(dark.on).toBe(true);
    // A room a stop under blows out at full brightness.
    expect(dim.alpha).toBeLessThan(dark.alpha);
    expect(dark.alpha).toBeLessThanOrEqual(1);
  });

  it('never waits for ever, and never fires and grabs at once', () => {
    const plan = flashPlan({ centre: 20, whole: 20 });
    expect(plan.minHoldMs).toBeGreaterThanOrEqual(150);
    expect(plan.maxHoldMs).toBeGreaterThan(plan.minHoldMs);
    expect(plan.maxHoldMs).toBeLessThanOrEqual(2000);
  });

  it('is warm rather than pure white', () => {
    // Pure panel white against tungsten gives the camera two colour
    // temperatures to reconcile, and it picks badly.
    expect(flashPlan({ centre: 20, whole: 20 }).colour).toMatch(/^#fff/i);
    expect(flashPlan({ centre: 20, whole: 20 }).colour).not.toBe('#ffffff');
  });
});

describe('waiting for the camera to catch up', () => {
  it('is not settled while it is still climbing', () => {
    expect(hasSettled([20, 45, 80], 2.5)).toBe(false);
  });

  // Many cameras overshoot and come back; grabbing at the top is the one
  // outcome worse than not flashing at all.
  it('is not settled at an overshoot', () => {
    expect(hasSettled([20, 60, 140], 2.5)).toBe(false);
  });

  it('is settled once two readings agree', () => {
    expect(hasSettled([20, 60, 118, 119], 2.5)).toBe(true);
  });

  it('is never settled before it has looked twice', () => {
    expect(hasSettled([], 2.5)).toBe(false);
    expect(hasSettled([118], 2.5)).toBe(false);
  });
});

describe('the lift put through before the picture is encoded', () => {
  it('leaves a well-lit frame exactly alone', () => {
    expect(liftFor({ centre: 130, whole: 130 })).toEqual({ multiplier: 1, offset: 0 });
  });

  it('lifts a dark frame towards a face', () => {
    const lift = liftFor({ centre: 30, whole: 30 });
    expect(lift.offset).toBeGreaterThan(20);
    expect(30 * lift.multiplier + lift.offset).toBeGreaterThan(90);
  });

  // It recovers no light: past a point a dark frame only gets louder.
  it('is bounded, however black the frame', () => {
    const lift = liftFor({ centre: 0, whole: 0 });
    expect(lift.offset).toBeLessThanOrEqual(70);
    expect(lift.multiplier).toBeLessThanOrEqual(1.6);
  });

  it('never darkens anything', () => {
    for (const centre of [0, 20, 44, 69, 70, 200]) {
      const lift = liftFor({ centre, whole: centre });
      expect(lift.multiplier).toBeGreaterThanOrEqual(1);
      expect(lift.offset).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('what the guest is told', () => {
  it('says nothing when the room is fine', () => {
    expect(guidanceFor({ centre: 130, whole: 130 }, false)).toBeNull();
    expect(guidanceFor({ centre: 130, whole: 130 }, true)).toBeNull();
  });

  it('warns before the screen lights up', () => {
    expect(guidanceFor({ centre: 30, whole: 30 }, false)).toMatch(/screen will light up/);
  });

  // Only where it can still help: after the screen has done what it can,
  // moving is the only thing left.
  it('asks them to move only when the screen was not enough', () => {
    expect(guidanceFor({ centre: 20, whole: 20 }, true)).toMatch(/nearer a light/);
    expect(guidanceFor({ centre: 60, whole: 60 }, true)).toBeNull();
  });
});
