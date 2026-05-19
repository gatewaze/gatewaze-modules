/**
 * Tests for lib/jobs/stream-keys.ts — BRAND prefixing + key shape.
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest';

// We must mutate BRAND BEFORE the module loads since it's read at
// import-time. Use module isolation per test.
describe('stream-keys', () => {
  const origBrand = process.env.BRAND;
  beforeEach(() => {
    process.env.BRAND = 'example';
  });
  afterEach(() => {
    if (origBrand === undefined) delete process.env.BRAND;
    else process.env.BRAND = origBrand;
  });

  it('derives brand-prefixed keys', async () => {
    // Use a fresh import so the BRAND env capture re-runs.
    const mod = await import('../../lib/jobs/stream-keys.js?fresh=' + Date.now());
    expect(mod.recipeRunStreamKey('uuid-1')).toMatch(/^example:ai:run:uuid-1$/);
    expect(mod.threadStreamKey('uuid-2')).toMatch(/^example:ai:thread:uuid-2$/);
    expect(mod.recipeRunCancelChannel('uuid-3')).toMatch(/^example:ai:cancel:run:uuid-3$/);
    expect(mod.messageCancelChannel('uuid-4')).toMatch(/^example:ai:cancel:msg:uuid-4$/);
    expect(mod.useCaseSemaphoreKey('daily-briefing')).toMatch(/^example:ai:semaphore:use_case:daily-briefing$/);
  });

  it('exposes TTL constants', async () => {
    const mod = await import('../../lib/jobs/stream-keys.js');
    expect(mod.STREAM_TTL_SECONDS).toBeGreaterThan(0);
    expect(mod.STREAM_MAXLEN).toBeGreaterThan(0);
    expect(mod.SEMAPHORE_TTL_SECONDS).toBeGreaterThan(0);
  });
});
