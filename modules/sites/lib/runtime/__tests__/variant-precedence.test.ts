import { describe, expect, it } from 'vitest';
import { selectVariant, scoreEligibility, type VariantCandidate } from '../variant-precedence.js';

const v = (
  id: string,
  match_context: Record<string, string | number | boolean | null>,
  updated_at: string,
  content: unknown = { hero: id },
): VariantCandidate => ({ id, match_context, updated_at, content });

describe('scoreEligibility()', () => {
  it("returns the variant's specificity when all keys match", () => {
    expect(
      scoreEligibility(
        { persona: 'developer', 'geo.country': 'US' },
        { persona: 'developer', 'geo.country': 'US', 'utm.campaign': 'x' },
      ),
    ).toBe(2);
  });

  it('returns null when a key is absent in the request', () => {
    expect(
      scoreEligibility(
        { persona: 'developer', 'geo.country': 'US' },
        { persona: 'developer' },
      ),
    ).toBe(null);
  });

  it('returns null when a key value mismatches', () => {
    expect(
      scoreEligibility(
        { persona: 'developer' },
        { persona: 'enterprise' },
      ),
    ).toBe(null);
  });

  it('returns 0 for empty match_context (matches everything)', () => {
    expect(scoreEligibility({}, { persona: 'developer' })).toBe(0);
  });
});

describe('selectVariant() — spec §7.6 worked examples', () => {
  // V1: persona=developer       (Jan 1)
  // V2: geo.country=US           (Jan 2)
  // V3: persona=developer + geo.country=US  (Jan 3)
  const V1 = v('aaa', { persona: 'developer' }, '2026-01-01T00:00:00Z');
  const V2 = v('bbb', { 'geo.country': 'US' }, '2026-01-02T00:00:00Z');
  const V3 = v('ccc', { persona: 'developer', 'geo.country': 'US' }, '2026-01-03T00:00:00Z');
  const variants = [V1, V2, V3];

  it('persona=developer + geo.country=US → V3 wins (highest specificity)', () => {
    const winner = selectVariant(variants, { persona: 'developer', 'geo.country': 'US' });
    expect(winner?.id).toBe('ccc');
  });

  it('persona=developer + geo.country=GB → V1 wins (only eligible)', () => {
    const winner = selectVariant(variants, { persona: 'developer', 'geo.country': 'GB' });
    expect(winner?.id).toBe('aaa');
  });

  it('persona=enterprise + geo.country=US → V2 wins (only eligible)', () => {
    const winner = selectVariant(variants, { persona: 'enterprise', 'geo.country': 'US' });
    expect(winner?.id).toBe('bbb');
  });

  it('persona=enterprise + geo.country=GB → no winner (none eligible)', () => {
    expect(selectVariant(variants, { persona: 'enterprise', 'geo.country': 'GB' })).toBe(null);
  });

  it('returns null on empty variants list', () => {
    expect(selectVariant([], { persona: 'developer' })).toBe(null);
  });
});

describe('selectVariant() — tiebreakers', () => {
  it('breaks ties on equal specificity by most recent updated_at', () => {
    const a = v('aaa', { persona: 'developer' }, '2026-01-01T00:00:00Z');
    const b = v('bbb', { persona: 'developer' }, '2026-02-01T00:00:00Z');  // newer
    const winner = selectVariant([a, b], { persona: 'developer' });
    expect(winner?.id).toBe('bbb');
  });

  it('breaks ties on equal specificity AND equal updated_at by lexicographic id', () => {
    const a = v('aaa', { persona: 'developer' }, '2026-01-01T00:00:00Z');
    const b = v('bbb', { persona: 'developer' }, '2026-01-01T00:00:00Z');
    const winner = selectVariant([a, b], { persona: 'developer' });
    expect(winner?.id).toBe('aaa'); // lexicographically smaller
  });

  it('different match_contexts of equal length: most-specific scoring is by KEY COUNT, not value', () => {
    // Both have specificity 1 against a request with both keys.
    const a = v('aaa', { persona: 'developer' }, '2026-01-01T00:00:00Z');
    const b = v('bbb', { 'geo.country': 'US' }, '2026-02-01T00:00:00Z'); // newer
    const winner = selectVariant([a, b], { persona: 'developer', 'geo.country': 'US' });
    expect(winner?.id).toBe('bbb'); // newer wins the tie
  });
});

describe('selectVariant() — empty match_context', () => {
  it('a variant with empty match_context scores 0 and matches every request', () => {
    const fallback = v('default', {}, '2026-01-01T00:00:00Z');
    const winner = selectVariant([fallback], { persona: 'developer' });
    expect(winner?.id).toBe('default');
  });

  it('a more-specific eligible variant beats the empty-context fallback', () => {
    const fallback = v('default', {}, '2026-02-01T00:00:00Z');
    const specific = v('persona', { persona: 'developer' }, '2026-01-01T00:00:00Z');
    const winner = selectVariant([fallback, specific], { persona: 'developer' });
    expect(winner?.id).toBe('persona');
  });
});
