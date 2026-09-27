import { describe, it, expect } from 'vitest';
import { ENHANCE_PROMPT, opsFor, parseVerdict, worthEnhancing } from '../enhance.js';

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
    expect(most.linear.multiplier).toBeCloseTo(1.2, 3);
    expect(most.modulate.saturation).toBeCloseTo(1.2, 3);
    expect(most.tint.red).toBeCloseTo(1.06, 3);
    expect(most.tint.blue).toBeCloseTo(0.94, 3);
    expect(most.sharpenSigma).toBeLessThanOrEqual(1.5);

    const least = opsFor(verdict({ exposure: -100, contrast: -100, warmth: -100, saturation: -100 }));
    expect(least.linear.multiplier).toBeCloseTo(0.8, 3);
    expect(least.modulate.saturation).toBeCloseTo(0.8, 3);
    expect(least.tint.red).toBeCloseTo(0.94, 3);
  });

  it('lifts a dark photograph without touching its contrast', () => {
    const ops = opsFor(verdict({ exposure: 50 }));
    expect(ops.linear.multiplier).toBe(1);
    expect(ops.linear.offset).toBeCloseTo(14, 1);
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
