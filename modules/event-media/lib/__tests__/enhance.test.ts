import { describe, it, expect } from 'vitest';
import { ENHANCE_PROMPT, applyOps, channelMeans, darkPoint, exposureFor, meanLuma, multiplierFor, neutraliseFor, neutraliseOps, opsFor, parseVerdict, withMeasuredTone, worthEnhancing } from '../enhance.js';

const verdict = (over = {}) => ({
  needs: true, exposure: 0, contrast: 0, warmth: 0, saturation: 0, sharpen: 0, note: '', ...over,
});

describe('reading what the model said', () => {
  it('takes the JSON out of whatever it is wrapped in', () => {
    const body = '{"needs":true,"exposure":20,"contrast":10,"warmth":-5,"saturation":8,"sharpen":30,"note":"A little dark."}';
    for (const text of [body, '```json\n' + body + '\n```', 'Sure! ' + body, body + '\nHope that helps.']) {
      const v = parseVerdict(text);
      expect(v?.exposure).toBe(20);
      expect(v?.note).toBe('A little dark.');
    }
  });

  // The answer is a model's, so every number is pulled back into range
  // rather than trusted.
  it('clamps what it is given, and drops what it cannot read', () => {
    const wild = parseVerdict('{"needs":true,"exposure":9000,"contrast":-9000,"warmth":"hot","saturation":null,"sharpen":-50}');
    expect(wild).toEqual(expect.objectContaining({ exposure: 100, contrast: -100, warmth: 0, saturation: 0, sharpen: 0 }));
    for (const junk of ['', 'no', '{not json}', '[]', 'x'.repeat(5000)]) {
      expect(parseVerdict(junk)).toBeNull();
    }
  });

  it('treats a missing verdict as "leave it alone"', () => {
    expect(worthEnhancing(verdict({ needs: false, exposure: 80 }))).toBe(false);
    expect(worthEnhancing(verdict())).toBe(false);
    expect(worthEnhancing(verdict({ exposure: 3 }))).toBe(false);
    expect(worthEnhancing(verdict({ exposure: 12 }))).toBe(true);
    expect(worthEnhancing(verdict({ sharpen: 20 }))).toBe(true);
  });

  it('asks about the photograph, not about the people in it', () => {
    expect(ENHANCE_PROMPT).toMatch(/Do not comment on the people/);
    expect(ENHANCE_PROMPT).toMatch(/JSON only/);
  });
});

describe('what the photograph is actually put through', () => {
  it('does nothing at all when nothing was asked for', () => {
    const ops = opsFor(verdict());
    expect(ops.linear).toEqual({ multiplier: 1, offset: 0 });
    expect(ops.modulate.saturation).toBe(1);
    expect(ops.tint).toEqual({ red: 1, blue: 1 });
    expect(ops.sharpenSigma).toBe(0);
  });

  // The ceilings are the difference between an enhancement and a
  // different photograph: the most extreme answer the model can give
  // still has to land within them.
  it('keeps the strongest possible answer gentle', () => {
    const most = opsFor(verdict({ exposure: 100, contrast: 100, warmth: 100, saturation: 100, sharpen: 100 }));
    expect(most.linear.multiplier).toBeCloseTo(1.3, 3);
    expect(most.modulate.saturation).toBeCloseTo(1.25, 3);
    expect(most.tint.red).toBeCloseTo(1.06, 3);
    expect(most.tint.blue).toBeCloseTo(0.94, 3);
    expect(most.sharpenSigma).toBeLessThanOrEqual(2);
    // Two thirds of a stop at the very most: a lift, never a relight.
    expect(most.linear.offset).toBeLessThanOrEqual(60);

    const least = opsFor(verdict({ exposure: -100, contrast: -100, warmth: -100, saturation: -100 }));
    expect(least.linear.multiplier).toBeCloseTo(0.7, 3);
    expect(least.modulate.saturation).toBeCloseTo(0.75, 3);
    expect(least.tint.red).toBeCloseTo(0.94, 3);
  });

  it('lifts a dark photograph without touching its contrast', () => {
    const ops = opsFor(verdict({ exposure: 50 }));
    expect(ops.linear.multiplier).toBe(1);
    // Enough to see: a dark room was the reason for this feature.
    expect(ops.linear.offset).toBeCloseTo(27.5, 1);
  });

  it('pivots contrast around mid grey, so mid tones stay put', () => {
    const ops = opsFor(verdict({ contrast: 100 }));
    const midOut = 128 * ops.linear.multiplier + ops.linear.offset;
    expect(midOut).toBeCloseTo(128, 6);
    // ...and the ends move apart.
    expect(60 * ops.linear.multiplier + ops.linear.offset).toBeLessThan(60);
    expect(200 * ops.linear.multiplier + ops.linear.offset).toBeGreaterThan(200);
  });

  it('never leaves brightness to be applied twice', () => {
    // modulate carries colour only; exposure lives in the linear offset.
    expect(opsFor(verdict({ exposure: 100 })).modulate.brightness).toBe(1);
  });
});

describe('the adjustments on real pixels', () => {
  /** A flat grey image, as RGBA. */
  const grey = (w: number, h: number, v = 128) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < d.length; i += 4) { d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255; }
    return d;
  };

  it('leaves a photograph alone when nothing was asked for', () => {
    const d = grey(4, 4, 120);
    applyOps(d, 4, 4, opsFor(verdict()));
    expect([...d.slice(0, 3)]).toEqual([120, 120, 120]);
  });

  it('lifts a dark photograph', () => {
    const d = grey(4, 4, 80);
    applyOps(d, 4, 4, opsFor(verdict({ exposure: 50 })));
    expect(d[0]).toBeGreaterThan(80);
    expect(d[0]).toBeLessThan(110);
  });

  it('leaves mid grey where it is when adding contrast', () => {
    const d = grey(4, 4, 128);
    applyOps(d, 4, 4, opsFor(verdict({ contrast: 100 })));
    expect(d[0]).toBeGreaterThanOrEqual(127);
    expect(d[0]).toBeLessThanOrEqual(129);
  });

  it('warms by lifting red and dropping blue, and never the other way', () => {
    const d = grey(4, 4, 120);
    applyOps(d, 4, 4, opsFor(verdict({ warmth: 100 })));
    expect(d[0]).toBeGreaterThan(d[1]!);
    expect(d[2]).toBeLessThan(d[1]!);
  });

  it('keeps grey grey however much colour is asked for', () => {
    const d = grey(4, 4, 120);
    applyOps(d, 4, 4, opsFor(verdict({ saturation: 100 })));
    expect(d[0]).toBe(d[1]);
    expect(d[1]).toBe(d[2]);
  });

  it('leaves the alpha channel alone', () => {
    const d = grey(4, 4, 90);
    applyOps(d, 4, 4, opsFor(verdict({ exposure: 60, contrast: 40, saturation: 30, sharpen: 50 })));
    for (let i = 3; i < d.length; i += 4) expect(d[i]).toBe(255);
  });

  it('sharpens an edge without touching a flat field', () => {
    // Left half dark, right half light: sharpening should deepen the step.
    const w = 9, h = 9;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = x < 4 ? 80 : 180;
        const o = (y * w + x) * 4;
        d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255;
      }
    }
    const before = { dark: d[(4 * w + 3) * 4]!, light: d[(4 * w + 4) * 4]! };
    applyOps(d, w, h, opsFor(verdict({ sharpen: 100 })));
    expect(d[(4 * w + 3) * 4]).toBeLessThan(before.dark);
    expect(d[(4 * w + 4) * 4]).toBeGreaterThan(before.light);

    const flat = grey(9, 9, 120);
    applyOps(flat, 9, 9, opsFor(verdict({ sharpen: 100 })));
    expect(flat[(4 * 9 + 4) * 4]).toBe(120);
  });
});

describe('a floor under a timid model', () => {
  const flat = (v: number) => {
    const d = new Uint8ClampedArray(64 * 4);
    for (let i = 0; i < d.length; i += 4) { d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255; }
    return d;
  };

  it('measures how dark a photograph is', () => {
    expect(meanLuma(flat(0))).toBeCloseTo(0, 0);
    expect(meanLuma(flat(128))).toBeCloseTo(128, 0);
    expect(meanLuma(flat(255))).toBeCloseTo(255, 0);
    expect(meanLuma(new Uint8ClampedArray(0))).toBe(128);
  });

  // The booth's room averaged about 50. A model that answers "a touch of
  // sharpening" to that is wrong, and the pixels are not a matter of
  // opinion.
  it('lifts a dark photograph past what the model asked for', () => {
    expect(exposureFor(50, 1, 3)).toBeGreaterThan(3);
    expect(exposureFor(90, 1, 0)).toBeGreaterThan(0);
  });

  // The fault reported on 2026-09-29: every enhanced photograph came out
  // at the same brightness, so a candlelit room looked like a lit one.
  it('leaves a darker photograph darker than a brighter one', () => {
    const dark = 60 + exposureFor(60, 1, 0);
    const dim = 95 + exposureFor(95, 1, 0);
    expect(dark).toBeLessThan(dim);
    // And neither is dragged onto the target itself.
    expect(dark).toBeLessThan(118);
  });

  // The other half of that fault: the lift used to replace the whole
  // offset, discarding the `128 - 128 * m` contrast pivot, so black was
  // lifted to the offset and the photograph went milky.
  it('keeps the contrast pivot when it corrects the exposure', () => {
    const ops = opsFor({ contrast: 50, exposure: 20, saturation: 0, warmth: 0, sharpen: 0, verdict: 'yes' });
    const fixed = withMeasuredTone(ops, 60, 40);
    // The contrast may be raised to protect the shadows, never lowered.
    expect(fixed.linear.multiplier).toBeGreaterThanOrEqual(ops.linear.multiplier);
    // Black stays near black rather than being lifted onto the offset.
    const black = new Uint8ClampedArray([0, 0, 0, 255]);
    applyOps(black, 1, 1, fixed);
    expect(black[0]!).toBeLessThan(30);
  });

  it('pulls back a photograph that would come out washed out', () => {
    // Already bright, and the model asked for a big lift on top.
    const at = 150 + exposureFor(150, 1, 40);
    expect(at).toBeLessThanOrEqual(146);
  });

  it('never darkens a photograph that is merely moody', () => {
    // Below the ceiling and above nothing: the model's answer stands.
    expect(exposureFor(125, 1, 0)).toBe(0);
  });

  it('has a ceiling of its own', () => {
    expect(exposureFor(0, 1, 0)).toBeLessThanOrEqual(55);
    expect(exposureFor(255, 1, 0)).toBeGreaterThanOrEqual(-55);
  });
});

/**
 * Lifting exposure adds a constant, so it moves black as far as it moves
 * everything else. Measured on the wedding's dark photographs: shadows
 * that sat at 8 came out at 38, which is not black, and that is what the
 * milky look actually was.
 */
describe('putting the shadows back', () => {
  /** An image with a real black point and a real highlight. */
  const scene = (dark: number, light: number) => {
    const d = new Uint8ClampedArray(64 * 4);
    for (let i = 0; i < d.length; i += 4) {
      const v = i < d.length / 2 ? dark : light;
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
    return d;
  };

  it('finds where a photograph\'s shadows sit', () => {
    expect(darkPoint(scene(10, 200))).toBeLessThanOrEqual(11);
    expect(darkPoint(new Uint8ClampedArray(0))).toBe(0);
  });

  it('raises contrast enough to hold the black point down', () => {
    const dark = 8;
    const exposure = 38;
    const m = multiplierFor(dark, exposure, 1.03);
    expect(m).toBeGreaterThan(1.03);
    // Black lands near where it started rather than 38 levels above it.
    const landed = dark * m + (128 - 128 * m) + exposure;
    expect(landed).toBeLessThan(dark + 14);
  });

  it('leaves contrast alone when nothing was lifted', () => {
    expect(multiplierFor(8, 0, 1.1)).toBe(1.1);
    expect(multiplierFor(8, -10, 1.1)).toBe(1.1);
  });

  it('never lowers the contrast the model asked for, and keeps a ceiling', () => {
    expect(multiplierFor(8, 40, 1.25)).toBeGreaterThanOrEqual(1.25);
    expect(multiplierFor(2, 55, 1.0)).toBeLessThanOrEqual(1.30);
    // A photograph with no shadows to protect is left to the model.
    expect(multiplierFor(140, 40, 1.05)).toBe(1.05);
  });

  it('holds black down on a real dark scene, end to end', () => {
    const data = scene(8, 190);
    const ops = withMeasuredTone(
      opsFor({ contrast: 10, exposure: 40, saturation: 0, warmth: 0, sharpen: 0, verdict: 'yes' }),
      meanLuma(data),
      darkPoint(data),
    );
    applyOps(data, 8, 8, ops);
    // Without the contrast correction this shadow came out in the high 30s.
    expect(data[0]!).toBeLessThan(28);
  });

  it('asks the model to use the whole scale', () => {
    expect(ENHANCE_PROMPT).toMatch(/10 is a nudge nobody will see/);
    expect(ENHANCE_PROMPT).toMatch(/50 to 80, not 5/);
  });
});

/**
 * ControlLight warms every photograph it touches. Measured over the
 * night-before album on 2026-09-29: red rose against green on all seven,
 * by 0.035 to 0.162, and the copies read as too warm (reported the same
 * day). The drift differs per photograph, so it is measured rather than
 * corrected by a fixed amount.
 */
describe('taking the model\'s warm cast back out', () => {
  const flat = (r: number, g: number, b: number) => {
    const d = new Uint8ClampedArray(64 * 4);
    for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
    return d;
  };

  it('reads where each channel sits', () => {
    const m = channelMeans(flat(120, 100, 80));
    expect(m.r).toBeCloseTo(120, 0);
    expect(m.g).toBeCloseTo(100, 0);
    expect(m.b).toBeCloseTo(80, 0);
    expect(channelMeans(new Uint8ClampedArray(0))).toEqual({ r: 128, g: 128, b: 128 });
  });

  it('cools a copy the model warmed, and lifts the blue it took', () => {
    // The real shape: R/G 1.163 -> 1.326, B/G 0.860 -> 0.755.
    const was = channelMeans(flat(116, 100, 86));
    const now = channelMeans(flat(133, 100, 76));
    const { red, blue } = neutraliseFor(was, now);
    expect(red).toBeLessThan(1);
    expect(blue).toBeGreaterThan(1);
  });

  it('lands the copy near the original\'s own colour', () => {
    const was = channelMeans(flat(116, 100, 86));
    const now = channelMeans(flat(133, 100, 76));
    const { red } = neutraliseFor(was, now);
    // 80% of the way back, by design: the model is entitled to some of
    // the warmth it added as part of the relighting.
    const landed = (133 * red) / 100;
    expect(landed).toBeGreaterThan(1.16);
    expect(landed).toBeLessThan(1.22);
  });

  it('does nothing to a copy that did not drift', () => {
    const same = channelMeans(flat(116, 100, 86));
    expect(neutraliseFor(same, same)).toEqual({ red: 1, blue: 1 });
  });

  it('never runs away on a strange measurement', () => {
    const odd = neutraliseFor(channelMeans(flat(255, 1, 255)), channelMeans(flat(1, 255, 1)));
    expect(odd.red).toBeLessThanOrEqual(1.35);
    expect(odd.red).toBeGreaterThanOrEqual(0.75);
    expect(odd.blue).toBeLessThanOrEqual(1.35);
    expect(odd.blue).toBeGreaterThanOrEqual(0.75);
  });

  it('touches the colour and leaves the light alone', () => {
    const ops = neutraliseOps(channelMeans(flat(116, 100, 86)), channelMeans(flat(133, 100, 76)));
    expect(ops.linear).toEqual({ multiplier: 1, offset: 0 });
    expect(ops.modulate.saturation).toBe(1);
    expect(ops.sharpenSigma).toBe(0);
    // Green is the reference, so a grey-green pixel keeps its value.
    const d = flat(120, 120, 120);
    applyOps(d, 8, 8, ops);
    expect(d[1]).toBe(120);
  });
});
