/**
 * Unit tests for domain governance (spec §7).
 */

import { describe, it, expect } from 'vitest';
import { matchPattern, evaluateHost } from '../lib/domains.js';

describe('matchPattern', () => {
  it('matches exact host', () => {
    expect(matchPattern('example.com', 'example.com')).toBe(true);
    expect(matchPattern('foo.example.com', 'example.com')).toBe(false);
  });

  it('subdomain wildcard does not match bare domain', () => {
    expect(matchPattern('example.com', '*.example.com')).toBe(false);
    expect(matchPattern('foo.example.com', '*.example.com')).toBe(true);
    expect(matchPattern('a.b.example.com', '*.example.com')).toBe(true);
  });

  it('suffix-and-self matches both', () => {
    expect(matchPattern('example.com', '**.example.com')).toBe(true);
    expect(matchPattern('foo.example.com', '**.example.com')).toBe(true);
  });

  it('case-insensitive', () => {
    expect(matchPattern('Example.COM', 'example.com')).toBe(true);
  });

  it('matches IPv6 bracketed literals', () => {
    expect(matchPattern('[::1]', '[::1]')).toBe(true);
  });
});

describe('evaluateHost', () => {
  it('blocks via instance denylist first', () => {
    const decision = evaluateHost('example.com', {
      instanceDeny: ['example.com'],
      instanceAllow: [],
      keyDeny: [],
      keyAllow: [],
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.rule).toBe('instance_denylist');
  });

  it('allows when no rules match', () => {
    const decision = evaluateHost('example.com', {
      instanceDeny: [],
      instanceAllow: [],
      keyDeny: [],
      keyAllow: [],
    });
    expect(decision.ok).toBe(true);
  });

  it('instance allowlist enforces if non-empty', () => {
    const decision = evaluateHost('other.com', {
      instanceDeny: [],
      instanceAllow: ['example.com'],
      keyDeny: [],
      keyAllow: [],
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.rule).toBe('instance_allowlist_violation');
  });

  it('key denylist takes precedence over key allowlist', () => {
    const decision = evaluateHost('example.com', {
      instanceDeny: [],
      instanceAllow: [],
      keyDeny: ['example.com'],
      keyAllow: ['example.com'],
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.rule).toBe('key_denylist');
  });
});
