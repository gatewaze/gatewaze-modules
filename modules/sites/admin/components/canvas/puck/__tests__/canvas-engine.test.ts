// @ts-nocheck — vitest types resolved at workspace install time
import { describe, expect, it } from 'vitest';
import {
  resolveEngine,
  applyCapabilityCheck,
  platformDefaultFromEnv,
  DEFAULT_ENGINE,
} from '../../canvas-engine.js';

describe('resolveEngine', () => {
  it('returns site-level setting when valid', () => {
    expect(resolveEngine({ canvas: { engine: 'puck' } })).toBe('puck');
    expect(resolveEngine({ canvas: { engine: 'legacy' } })).toBe('legacy');
  });

  it('falls back to platform default when site value is missing or invalid', () => {
    expect(resolveEngine(null, 'puck')).toBe('puck');
    expect(resolveEngine({ canvas: {} }, 'puck')).toBe('puck');
    expect(resolveEngine({ canvas: { engine: 'something-else' as any } }, 'puck')).toBe('puck');
  });

  it('falls back to DEFAULT_ENGINE when neither site nor platform value is set', () => {
    expect(resolveEngine(undefined, undefined)).toBe(DEFAULT_ENGINE);
    expect(resolveEngine(null)).toBe(DEFAULT_ENGINE);
    expect(DEFAULT_ENGINE).toBe('legacy');
  });
});

describe('applyCapabilityCheck', () => {
  it('demotes puck → legacy when IntersectionObserver missing', () => {
    expect(applyCapabilityCheck('puck', false)).toEqual({ engine: 'legacy', demoted: true });
  });

  it('passes through when IntersectionObserver present', () => {
    expect(applyCapabilityCheck('puck', true)).toEqual({ engine: 'puck', demoted: false });
  });

  it('never demotes legacy', () => {
    expect(applyCapabilityCheck('legacy', false)).toEqual({ engine: 'legacy', demoted: false });
  });
});

describe('platformDefaultFromEnv', () => {
  it.each(['legacy', 'puck'])('accepts %s', (v) => {
    expect(platformDefaultFromEnv(v)).toBe(v);
  });

  it('rejects bogus values and undefined', () => {
    expect(platformDefaultFromEnv(undefined)).toBeUndefined();
    expect(platformDefaultFromEnv('')).toBeUndefined();
    expect(platformDefaultFromEnv('grapesjs')).toBeUndefined();
  });
});
