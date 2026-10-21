import { describe, expect, it } from 'vitest';
import { MINOR_FACE, coverScore, cropToFaces, faceSpan, normaliseBox, significant } from '../faces';
import { cropTo } from '../framing';

/** A face at a spot, as a fraction of the frame. */
const face = (x: number, y: number, w = 0.1, h = 0.12, score = 0.9) => ({ x, y, w, h, score });

describe('normaliseBox', () => {
  it('turns a detector box into fractions of the frame it was found in', () => {
    // Detection runs on a small copy; the answer must not depend on that.
    expect(normaliseBox({ x: 64, y: 48, w: 128, h: 96 }, { w: 640, h: 480 }))
      .toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });

  it('gives the same answer whatever size the copy was', () => {
    const small = normaliseBox({ x: 64, y: 48, w: 128, h: 96 }, { w: 640, h: 480 })!;
    const large = normaliseBox({ x: 400, y: 300, w: 800, h: 600 }, { w: 4000, h: 3000 })!;
    expect(small.x).toBeCloseTo(large.x, 6);
    expect(small.w).toBeCloseTo(large.w, 6);
  });

  // A detector will report a face half out of shot, and that is true.
  it('allows a face to hang outside the frame, but not a whole frame away', () => {
    expect(normaliseBox({ x: -20, y: 0, w: 60, h: 60 }, { w: 600, h: 600 })!.x).toBeCloseTo(-1 / 30, 6);
    expect(normaliseBox({ x: -6000, y: 0, w: 60, h: 60 }, { w: 600, h: 600 })!.x).toBe(-0.5);
  });

  it('refuses nonsense instead of writing it to a row', () => {
    expect(normaliseBox({ x: 0, y: 0, w: 10, h: 10 }, { w: 0, h: 100 })).toBeNull();
    expect(normaliseBox({ x: 0, y: 0, w: 0, h: 10 }, { w: 100, h: 100 })).toBeNull();
    expect(normaliseBox({ x: NaN, y: 0, w: 10, h: 10 }, { w: 100, h: 100 })).toBeNull();
  });
});

describe('significant', () => {
  it('ignores a guess and ignores somebody in the far distance', () => {
    const faces = [
      face(0.4, 0.3),                                   // kept
      face(0.1, 0.1, 0.1, 0.1, 0.2),                    // too unsure
      face(0.8, 0.8, MINOR_FACE / 2, MINOR_FACE / 2),   // too small
    ];
    expect(significant(faces)).toHaveLength(1);
  });
});

describe('faceSpan', () => {
  it('is the one box that holds them all', () => {
    const span = faceSpan([face(0.1, 0.2, 0.1, 0.1), face(0.6, 0.5, 0.1, 0.1)])!;
    expect(span.x).toBeCloseTo(0.1, 6);
    expect(span.y).toBeCloseTo(0.2, 6);
    expect(span.w).toBeCloseTo(0.6, 6);
    expect(span.h).toBeCloseTo(0.4, 6);
  });

  it('is null when there is nobody worth framing for', () => {
    expect(faceSpan([])).toBeNull();
    expect(faceSpan([face(0.1, 0.1, 0.1, 0.1, 0.1)])).toBeNull();
  });
});

describe('cropToFaces', () => {
  // The safety property: wherever this is used, a photograph with no
  // faces must come out exactly as it did before.
  it('is cropTo, unchanged, when there are no faces', () => {
    for (const [w, h, ratio] of [[4000, 2667, 2 / 3], [2667, 4000, 3 / 2], [1000, 1000, 3 / 2]] as const) {
      expect(cropToFaces(w, h, ratio, [])).toEqual(cropTo(w, h, ratio));
    }
  });

  it('keeps the window the size cropTo would have made it', () => {
    const faces = [face(0.8, 0.1)];
    const a = cropToFaces(4000, 2667, 2 / 3, faces);
    const b = cropTo(4000, 2667, 2 / 3);
    expect(a.w).toBe(b.w);
    expect(a.h).toBe(b.h);
  });

  it('moves the crop to the faces instead of the middle', () => {
    // A 4000x2667 landscape cropped to 2:3 keeps only 1778px of width.
    // Faces far right must not be cropped away by a centred window.
    const faces = [face(0.80, 0.25, 0.08, 0.10), face(0.90, 0.26, 0.08, 0.10)];
    const crop = cropToFaces(4000, 2667, 2 / 3, faces);
    const centred = cropTo(4000, 2667, 2 / 3);
    expect(crop.x).toBeGreaterThan(centred.x);
    // Every face is inside the crop.
    for (const f of faces) {
      expect(f.x * 4000).toBeGreaterThanOrEqual(crop.x);
      expect((f.x + f.w) * 4000).toBeLessThanOrEqual(crop.x + crop.w);
    }
  });

  // The thing this whole migration is for.
  it('does not cut the head off a tall photograph', () => {
    // Portrait original to a landscape 3:2: height is what gets cut.
    const faces = [face(0.4, 0.06, 0.2, 0.16)];   // head near the top
    const crop = cropToFaces(2667, 4000, 3 / 2, faces);
    const top = faces[0]!.y * 4000;
    expect(crop.y).toBeLessThanOrEqual(top);
    expect(crop.y + crop.h).toBeGreaterThanOrEqual((faces[0]!.y + faces[0]!.h) * 4000);
    // And the old rule WOULD have cut it, which is why this exists.
    expect(cropTo(2667, 4000, 3 / 2).y).toBeGreaterThan(top);
  });

  it('leaves room above the head rather than touching the scalp', () => {
    const f = face(0.4, 0.30, 0.2, 0.16);
    const crop = cropToFaces(2667, 4000, 3 / 2, [f]);
    // Strictly above the top of the face, not level with it.
    expect(crop.y).toBeLessThan(f.y * 4000);
  });

  it('centres on a group too wide for the crop rather than keeping one end', () => {
    // Faces spanning almost the full width, cropped to a narrow window.
    const faces = [face(0.03, 0.4, 0.06, 0.08), face(0.91, 0.4, 0.06, 0.08)];
    const crop = cropToFaces(4000, 2667, 2 / 3, faces);
    const spanCentre = ((0.03 + 0.97) / 2) * 4000;
    expect(crop.x + crop.w / 2).toBeCloseTo(spanCentre, -1);
  });

  it('never leaves the photograph', () => {
    for (const faces of [[face(-0.4, -0.4)], [face(1.3, 1.3)], [face(0.5, 0.5)]]) {
      const crop = cropToFaces(4000, 2667, 2 / 3, faces);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.w).toBeLessThanOrEqual(4000);
      expect(crop.y + crop.h).toBeLessThanOrEqual(2667);
    }
  });

  it('is not fooled by nonsense', () => {
    expect(cropToFaces(0, 0, 1.5, [face(0.5, 0.5)])).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(cropToFaces(100, 100, 0, [face(0.5, 0.5)])).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });
});

describe('coverScore', () => {
  it('prefers people to an empty room', () => {
    expect(coverScore([])).toBe(0);
    expect(coverScore([face(0.4, 0.3, 0.3, 0.35)])).toBeGreaterThan(0);
  });

  it('prefers a large face to a small one', () => {
    expect(coverScore([face(0.4, 0.3, 0.3, 0.35)]))
      .toBeGreaterThan(coverScore([face(0.4, 0.3, 0.05, 0.06)]));
  });

  it('prefers a couple to one stranger', () => {
    const two = [face(0.3, 0.3, 0.15, 0.18), face(0.55, 0.3, 0.15, 0.18)];
    expect(coverScore(two)).toBeGreaterThan(coverScore([face(0.3, 0.3, 0.15, 0.18)]));
  });

  it('marks down a face sliced by the edge of the frame', () => {
    const whole = [face(0.4, 0.3, 0.2, 0.24)];
    const sliced = [face(-0.08, 0.3, 0.2, 0.24)];
    expect(coverScore(whole)).toBeGreaterThan(coverScore(sliced));
  });

  it('stays within a sane range', () => {
    const crowd = Array.from({ length: 30 }, (_, i) => face((i % 6) / 6, 0.3, 0.3, 0.35, 1));
    expect(coverScore(crowd)).toBeLessThanOrEqual(1);
    expect(coverScore(crowd)).toBeGreaterThan(0);
  });
});
