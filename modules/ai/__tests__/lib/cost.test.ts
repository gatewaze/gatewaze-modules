import { describe, expect, it } from 'vitest';
import { computeCostMicroUsd } from '../../lib/cost.js';

describe('computeCostMicroUsd', () => {
  // Anthropic Claude Sonnet 4.5: $3 / $15 per million; cached $0.30.
  const sonnetPrice = {
    input_per_million_usd: 3,
    output_per_million_usd: 15,
    cached_per_million_usd: 0.30,
    image_per_image_usd: null,
  };

  it('computes input+output cost in micro-USD', () => {
    // 1000 input × $3/M = 3000 micro-USD (= $0.003)
    // 500 output × $15/M = 7500 micro-USD ($0.0075)
    // total: 10500 micro-USD ($0.0105)
    const cost = computeCostMicroUsd(sonnetPrice, {
      inputTokens: 1000,
      outputTokens: 500,
      kind: 'llm',
    });
    expect(cost).toBe(10500);
  });

  it('honours cached_per_million discount when present', () => {
    // 10k cached × $0.30/M = 3000 micro-USD ($0.003)
    const cost = computeCostMicroUsd(sonnetPrice, {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 10000,
      kind: 'llm',
    });
    expect(cost).toBe(3000);
  });

  it('falls back to zero cached cost when no cache price', () => {
    const noCachePrice = { ...sonnetPrice, cached_per_million_usd: null };
    const cost = computeCostMicroUsd(noCachePrice, {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 50000,
      kind: 'llm',
    });
    expect(cost).toBe(0);
  });

  it('handles image_per_image_usd', () => {
    // Gemini Nano Banana: $0.03 per image
    const imagePrice = {
      input_per_million_usd: 0,
      output_per_million_usd: 0,
      cached_per_million_usd: null,
      image_per_image_usd: 0.03,
    };
    // 1 image × $0.03 → 30_000 micro-USD ($0.03)
    const cost = computeCostMicroUsd(imagePrice, {
      inputTokens: 0,
      outputTokens: 0,
      imageOutputs: 1,
      kind: 'image',
    });
    expect(cost).toBe(30_000);
  });

  it('rounds to nearest micro-USD to avoid float drift', () => {
    // 0.5 × $3 = $1.5e-6 → rounds to 2 micro-USD
    const cost = computeCostMicroUsd(sonnetPrice, {
      inputTokens: 1,
      outputTokens: 0,
      kind: 'llm',
    });
    expect(cost).toBe(3);
  });

  it('handles zero-token zero-image events (e.g. cancelled before any work)', () => {
    expect(
      computeCostMicroUsd(sonnetPrice, { kind: 'llm' }),
    ).toBe(0);
  });
});
