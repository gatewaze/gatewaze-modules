/**
 * The studio's decisions, with numbers in and numbers out.
 *
 * Each threshold here was found against real AGNTCon EU frames; these tests
 * pin the direction of each rule so a retune is a deliberate edit.
 */

import { describe, it, expect } from 'vitest';
import {
  layoutOf, planCandidates, rankSpeakerFrames, rankSlideFrames, panelPasses, cutPasses, isCloseShot, leastBad,
  lowGlareCandidates, cameraCrop, slideCrop, spread,
} from '../lib/studio-analysis.js';
import type { FrameStats } from '../lib/studio-pixels.js';

const base = (over: Partial<FrameStats> = {}): FrameStats => ({
  sharp: 10, bottom: 40, left: 60, mean: 80, v_in: 50, v_out: 50, h_in: 50, h_out: 50,
  s_v_in: 50, s_v_out: 50, s_h_in: 50, s_h_out: 50, white: 0.1, ...over,
});

describe('layoutOf', () => {
  it('is a plain camera shot by default', () => {
    expect(layoutOf(base())).toBeNull();
  });
  it('reads the bright sponsor strip as the YouTube render', () => {
    expect(layoutOf(base({ bottom: 220 }))).toBe('strip');
  });
  it('reads the slide-over-ticker edge as the stream overlay', () => {
    expect(layoutOf(base({ h_in: 200, h_out: 40, v_in: 100, v_out: 20 }))).toBe('overlay');
  });
  it('does not call a bright horizontal edge an overlay without the vertical edge or a bright slide', () => {
    expect(layoutOf(base({ h_in: 140, h_out: 30 }))).toBeNull();
  });
  it('reads both strip edges as the render even without the bright strip', () => {
    expect(layoutOf(base({ s_v_in: 100, s_v_out: 40, s_h_in: 100, s_h_out: 40 }))).toBe('strip');
  });
});

describe('planCandidates', () => {
  const frames = Array.from({ length: 60 }, (_, i) => ({ t: i * 10, stats: base({ sharp: 5 + (i % 7) }) }));
  it('asks about twelve speaker frames and ten slide frames', () => {
    const plan = planCandidates(frames);
    expect(plan.speaker).toHaveLength(12);
    expect(plan.slide).toHaveLength(10);
    expect(plan.cameraOnly).toBe(false);
  });
  it('judges the speaker on the camera panel when the overlay covers most of the talk', () => {
    const mostly = frames.map((f, i) => (i % 3 === 0 ? f : { ...f, stats: base({ h_in: 200, h_out: 40, v_in: 100, v_out: 20 }) }));
    const plan = planCandidates(mostly);
    expect(plan.cameraOnly).toBe(true);
    expect(plan.overlayShare).toBeGreaterThan(0.3);
    for (const t of plan.speaker) expect(plan.layouts[t]).toBe('overlay');
  });
  it('spreads the picks over the talk rather than clustering at the sharpest moment', () => {
    const plan = planCandidates(frames);
    expect(Math.max(...plan.speaker) - Math.min(...plan.speaker)).toBeGreaterThan(300);
  });
});

describe('rankSpeakerFrames', () => {
  it('prefers a clear face and no glare, and drops small figures when a bigger one exists', () => {
    const r = rankSpeakerFrames([
      { t: 10, score: { kind: 'speaker', face: 9, pose: 5, glare: 0, size: 'small' }, sharp: 9 },
      { t: 20, score: { kind: 'speaker', face: 7, pose: 6, glare: 2, size: 'large' }, sharp: 5 },
      { t: 30, score: { kind: 'speaker', face: 6, pose: 6, glare: 8, size: 'large' }, sharp: 9 },
      { t: 40, score: { kind: 'slide' }, sharp: 9 },
    ]);
    expect(r.map((x) => x.t)).toEqual([20, 30]);
  });
  it('falls back to small figures when nothing else is a speaker', () => {
    expect(rankSpeakerFrames([{ t: 1, score: { kind: 'speaker', size: 'small', face: 5 }, sharp: 1 }]).map((x) => x.t)).toEqual([1]);
  });
});

describe('panels', () => {
  it('ranks legible, interesting slides first and refuses anything with a person at verification', () => {
    const r = rankSlideFrames([
      { t: 1, score: { kind: 'slide', legible: 9, interest: 9 } },
      { t: 2, score: { kind: 'speaker', legible: 9, interest: 9 } },
      { t: 3, score: { kind: 'code', legible: 6, interest: 5 } },
      { t: 4, score: { kind: 'slide', legible: 3, interest: 9 } },
    ]);
    expect(r.map((x) => x.t)).toEqual([1, 3]);
    expect(panelPasses({ person: false, kind: 'slide', legible: 7, interest: 6 })).toBe(true);
    expect(panelPasses({ person: true, kind: 'slide', legible: 9, interest: 9 })).toBe(false);
    expect(panelPasses({ person: false, kind: 'photo', legible: 9, interest: 9 })).toBe(false);
    expect(panelPasses({ person: false, kind: 'slide', legible: 5, interest: 9 })).toBe(false);
  });
});

describe('cut gates', () => {
  const tall = { x0: 800, y0: 200, x1: 1200, y1: 1070 };
  it('needs a close shot, no glare and no screen behind the head', () => {
    expect(cutPasses({ bbox: tall, glare: 0.02, screen: 0.1 })).toBe(true);
    expect(cutPasses({ bbox: { x0: 900, y0: 700, x1: 1000, y1: 1070 }, glare: 0, screen: 0 })).toBe(false);
    expect(cutPasses({ bbox: tall, glare: 0.2, screen: 0.1 })).toBe(false);
    expect(cutPasses({ bbox: tall, glare: 0.02, screen: 0.5 })).toBe(false);
    expect(cutPasses({ bbox: null, glare: 0, screen: 0 })).toBe(false);
  });
  it('a sliver is not a close shot even when tall', () => {
    expect(isCloseShot({ x0: 900, y0: 100, x1: 1000, y1: 1000 })).toBe(false);
  });
  it('least bad weighs glare twice as heavily as screen, among close shots only', () => {
    const r = leastBad([
      { key: 'a', bbox: tall, glare: 0.3, screen: 0.1 },
      { key: 'b', bbox: tall, glare: 0.12, screen: 0.4 },
      { key: 'c', bbox: { x0: 0, y0: 900, x1: 100, y1: 1000 }, glare: 0, screen: 0 },
    ]);
    expect(r?.key).toBe('b');
    expect(leastBad([])).toBeNull();
  });
});

describe('lowGlareCandidates', () => {
  it('prefers plain frames with the least near-white and skips what was tried', () => {
    const frames = [
      { t: 0, stats: base({ white: 0.5 }) },
      { t: 10, stats: base({ white: 0.05 }) },
      { t: 20, stats: base({ white: 0.02 }) },
      { t: 30, stats: base({ white: 0.01, bottom: 220 }) },
    ];
    const layouts = { 0: null, 10: null, 20: null, 30: 'strip' as const };
    expect(lowGlareCandidates(frames, layouts, new Set([20]), 5)).toEqual([10, 0]);
  });
});

describe('crops', () => {
  it('scales the layout boxes to the source width', () => {
    expect(cameraCrop('overlay', 1920)).toEqual([0, 130, 502, 756]);
    expect(slideCrop('strip', 3840)).toEqual([1296, 168, 2484, 1506]);
    expect(cameraCrop(null, 1920)).toBeNull();
  });
  it('spread keeps order and count', () => {
    expect(spread([1, 2, 3, 4, 5, 6], 3)).toEqual([1, 3, 5]);
    expect(spread([1, 2], 3)).toEqual([1, 2]);
  });
});
