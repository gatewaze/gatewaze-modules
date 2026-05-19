/**
 * extension-tiers classifier — full matrix per spec §4.3.
 *
 * Verifies the classifier is total over the expected (type, name)
 * space and that the refusal feature keys are stable so the admin UI
 * can show authors a specific reason.
 */

import { describe, expect, it } from 'vitest';
import { classifyExtension } from '../../lib/recipes/extension-tiers.js';

describe('classifyExtension — Tier 1 (honoured natively)', () => {
  it('streamable_http always Tier-1', () => {
    expect(classifyExtension({ type: 'streamable_http' }).tier).toBe(1);
    expect(classifyExtension({ type: 'streamable_http', name: 'x' }).tier).toBe(1);
  });

  it.each(['web_search', 'fetch_url', 'gatewaze_search'])(
    'bare name %s → Tier-1 (mapped to native tool)',
    (name) => {
      expect(classifyExtension({ name }).tier).toBe(1);
    },
  );

  it('STREAMABLE_HTTP type is case-insensitive', () => {
    expect(classifyExtension({ type: 'STREAMABLE_HTTP' }).tier).toBe(1);
  });
});

describe('classifyExtension — Tier 2 (persisted as metadata)', () => {
  it.each(['memory', 'chatrecall', 'todo', 'tom'])(
    'builtin %s → Tier-2',
    (name) => {
      expect(classifyExtension({ type: 'builtin', name }).tier).toBe(2);
    },
  );

  it('platform summon without uses → Tier-2', () => {
    expect(classifyExtension({ type: 'platform', name: 'summon' }).tier).toBe(2);
  });

  it('platform summon with uses=[load] → Tier-2', () => {
    expect(classifyExtension({ type: 'platform', name: 'summon', uses: ['load'] }).tier).toBe(2);
  });

  it('platform chatrecall → Tier-2', () => {
    expect(classifyExtension({ type: 'platform', name: 'chatrecall' }).tier).toBe(2);
  });

  it('stdio with cmd on allowlist → Tier-2', () => {
    const c = classifyExtension({
      type: 'stdio',
      cmd: '/usr/local/bin/safe',
      stdioAllowlist: ['/usr/local/bin/safe'],
    });
    expect(c.tier).toBe(2);
  });
});

describe('classifyExtension — Tier 3 (refused)', () => {
  it('platform summon with uses=[delegate] → model-driven-branching', () => {
    const c = classifyExtension({ type: 'platform', name: 'summon', uses: ['delegate'] });
    expect(c.tier).toBe(3);
    expect(c.refusalFeature).toBe('model-driven-branching');
  });

  it('summon uses=[load, delegate] → model-driven-branching (delegate dominates)', () => {
    const c = classifyExtension({
      type: 'platform',
      name: 'summon',
      uses: ['load', 'delegate'],
    });
    expect(c.refusalFeature).toBe('model-driven-branching');
  });

  it('inline_python → sandboxed-execution', () => {
    const c = classifyExtension({ type: 'inline_python' });
    expect(c.tier).toBe(3);
    expect(c.refusalFeature).toBe('sandboxed-execution');
  });

  it('frontend → frontend-extension', () => {
    const c = classifyExtension({ type: 'frontend' });
    expect(c.tier).toBe(3);
    expect(c.refusalFeature).toBe('frontend-extension');
  });

  it.each(['autovisualiser', 'computercontroller', 'peekaboo', 'tutorial'])(
    'desktop builtin %s → desktop-extension',
    (name) => {
      const c = classifyExtension({ type: 'builtin', name });
      expect(c.tier).toBe(3);
      expect(c.refusalFeature).toBe('desktop-extension');
    },
  );

  it.each([
    'developer',
    'analyze',
    'apps',
    'summarize',
    'code_execution',
    'orchestrator',
    'extensionmanager',
  ])('platform %s → tier-3-extension', (name) => {
    const c = classifyExtension({ type: 'platform', name });
    expect(c.tier).toBe(3);
    expect(c.refusalFeature).toBe('tier-3-extension');
  });

  it('unrecognised builtin → tier-3-extension', () => {
    const c = classifyExtension({ type: 'builtin', name: 'random_thing_42' });
    expect(c.tier).toBe(3);
    expect(c.refusalFeature).toBe('tier-3-extension');
  });

  it('unrecognised platform → tier-3-extension', () => {
    const c = classifyExtension({ type: 'platform', name: 'foo' });
    expect(c.tier).toBe(3);
    expect(c.refusalFeature).toBe('tier-3-extension');
  });

  it('stdio without cmd → stdio-not-allowlisted', () => {
    const c = classifyExtension({ type: 'stdio' });
    expect(c.tier).toBe(3);
    expect(c.refusalFeature).toBe('stdio-not-allowlisted');
  });

  it('stdio with cmd NOT on allowlist → stdio-not-allowlisted', () => {
    const c = classifyExtension({
      type: 'stdio',
      cmd: '/usr/bin/evil',
      stdioAllowlist: ['/usr/local/bin/safe'],
    });
    expect(c.tier).toBe(3);
    expect(c.refusalFeature).toBe('stdio-not-allowlisted');
    expect(c.details).toMatch(/cmd '\/usr\/bin\/evil' is not in the operator-controlled stdio allowlist/);
  });

  it('stdio with empty allowlist → stdio-not-allowlisted', () => {
    const c = classifyExtension({ type: 'stdio', cmd: '/usr/local/bin/safe' });
    expect(c.tier).toBe(3);
    expect(c.refusalFeature).toBe('stdio-not-allowlisted');
  });

  it('totally unknown shape → tier-3-extension', () => {
    const c = classifyExtension({ type: 'something_else', name: 'x' });
    expect(c.tier).toBe(3);
    expect(c.refusalFeature).toBe('tier-3-extension');
  });
});

describe('classifyExtension — case insensitivity + details', () => {
  it('BUILTIN MEMORY (upper) → Tier-2', () => {
    expect(classifyExtension({ type: 'BUILTIN', name: 'MEMORY' }).tier).toBe(2);
  });

  it('details string always populated for Tier-3', () => {
    const c = classifyExtension({ type: 'unknown' });
    expect(c.tier).toBe(3);
    expect(c.details).toBeTruthy();
  });
});
