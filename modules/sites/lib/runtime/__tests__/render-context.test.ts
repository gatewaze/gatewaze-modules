import { describe, expect, it } from 'vitest';
import { canonicalizeRenderContext, assertFlatContext } from '../render-context.js';

describe('canonicalizeRenderContext()', () => {
  it('accepts an already-flat context as canonical', () => {
    const result = canonicalizeRenderContext({
      persona: 'developer',
      'utm.campaign': 'mcp-security',
      'geo.country': 'US',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonical).toEqual({
        persona: 'developer',
        'utm.campaign': 'mcp-security',
        'geo.country': 'US',
      });
    }
  });

  it('flattens a nested context to dot-notation', () => {
    const result = canonicalizeRenderContext({
      persona: 'developer',
      utm: { campaign: 'mcp-security', source: 'linkedin' },
      geo: { country: 'US', region: 'CA' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonical).toEqual({
        persona: 'developer',
        'utm.campaign': 'mcp-security',
        'utm.source': 'linkedin',
        'geo.country': 'US',
        'geo.region': 'CA',
      });
    }
  });

  it('returns an empty canonical for null/undefined input', () => {
    expect(canonicalizeRenderContext(null)).toEqual({ ok: true, canonical: {} });
    expect(canonicalizeRenderContext(undefined)).toEqual({ ok: true, canonical: {} });
  });

  it('rejects an array input as malformed', () => {
    const result = canonicalizeRenderContext([1, 2, 3]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed_input');
  });

  it('rejects a primitive input as malformed', () => {
    const result = canonicalizeRenderContext('a string');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed_input');
  });

  it('rejects ambiguous input (both nested and flat key for same axis)', () => {
    const result = canonicalizeRenderContext({
      'geo.country': 'US',
      geo: { country: 'GB' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ambiguous_render_context');
  });

  it('rejects nesting beyond one level', () => {
    const result = canonicalizeRenderContext({
      viewer: { addr: { street: '1 Main St' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_value_type');
  });

  it('rejects array values', () => {
    const result = canonicalizeRenderContext({ persona: ['dev', 'enterprise'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_value_type');
  });

  it('preserves boolean and number scalars', () => {
    const result = canonicalizeRenderContext({
      'viewer.authenticated': false,
      'geo.lat': 37.7749,
      persona: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonical).toEqual({
        'viewer.authenticated': false,
        'geo.lat': 37.7749,
        persona: null,
      });
    }
  });

  it('flattens nested booleans and nulls', () => {
    const result = canonicalizeRenderContext({
      viewer: { authenticated: true, userId: null },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonical).toEqual({
        'viewer.authenticated': true,
        'viewer.userId': null,
      });
    }
  });
});

describe('assertFlatContext()', () => {
  it('accepts a flat context', () => {
    expect(() => assertFlatContext({ persona: 'dev', 'utm.campaign': 'x' })).not.toThrow();
  });

  it('rejects a context containing a nested object', () => {
    expect(() => assertFlatContext({ persona: 'dev', utm: { campaign: 'x' } })).toThrow(
      /must be flat/,
    );
  });

  it('accepts null values (a flat scalar)', () => {
    expect(() => assertFlatContext({ persona: null })).not.toThrow();
  });
});
