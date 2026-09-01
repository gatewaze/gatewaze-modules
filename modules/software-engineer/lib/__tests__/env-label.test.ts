/**
 * Pins the TS env-label port (lib/env-label.ts) against captured outputs of
 * the canonical Python implementation, `gatewaze-environments/scripts/
 * lfx-envlabel.py` (captured 2026-08-23 at gatewaze-environments 042fcac).
 * The host agent validates every request with the Python; the API encodes
 * with this port — the label IS the env identity, so the two must produce
 * byte-identical labels for every valid spec, and agree on what is invalid.
 *
 * Each `label:` expectation below is the literal stdout of
 * `echo '<spec json>' | python3 lfx-envlabel.py encode`. Invalid cases pin
 * the CLASSIFICATION (both sides reject), not the error prose — the reasons
 * are surfaced to humans, not compared across implementations.
 */
import { describe, it, expect } from 'vitest';
import { encodeEnvLabel, parseEnvLabel, envTierCheck, slugifyBranch, ENV_MAX_LABEL } from '../env-label.js';

describe('encodeEnvLabel — pinned against lfx-envlabel.py encode', () => {
  const valid: Array<{ spec: unknown; label: string }> = [
    { spec: [{ repo: 'lfx-v2-newsletter-service', pr: 80 }], label: 'lfx--newsletter-80' },
    {
      spec: [{ repo: 'lfx-self-serve', pr: 1688 }, { repo: 'lfx-v2-newsletter-service', pr: 63 }],
      label: 'lfx--self-serve-1688--newsletter-63',
    },
    {
      // Adjacent same-repo groups merge (canonicalisation, spec §2.3).
      spec: [{ repo: 'lfx-v2-newsletter-service', pr: 63 }, { repo: 'lfx-v2-newsletter-service', pr: 71 }],
      label: 'lfx--newsletter-63-71',
    },
    {
      // Non-adjacent repeats stay separate — order is semantic.
      spec: [
        { repo: 'lfx-v2-newsletter-service', pr: 5 },
        { repo: 'lfx-self-serve', pr: 3 },
        { repo: 'lfx-v2-newsletter-service', pr: 7 },
      ],
      label: 'lfx--newsletter-5--self-serve-3--newsletter-7',
    },
    { spec: [{ repo: 'lfx-v2-newsletter-service', branch: 'feat/send-retry' }], label: 'lfx--newsletter-b-feat-send-retry' },
    {
      // Slug is lossy: lowercased, non-alnum runs collapse to '-'.
      spec: [{ repo: 'lfx-self-serve', branch: 'dan/WIP_thing--x' }, { repo: 'lfx-v2-newsletter-service', pr: 210 }],
      label: 'lfx--self-serve-b-dan-wip-thing-x--newsletter-210',
    },
    {
      // Slug truncates at 20 chars then strips trailing hyphens.
      spec: [{ repo: 'lfx-v2-newsletter-service', branch: 'feature/a-very-long-branch-name-here' }],
      label: 'lfx--newsletter-b-feature-a-very-long',
    },
    // Tier-B/helm ENCODE fine — the tier check is a separate policy layer.
    { spec: [{ repo: 'lfx-v2-email-service', pr: 4 }], label: 'lfx--email-4' },
    { spec: [{ repo: 'lfx-v2-helm', pr: 4 }], label: 'lfx--helm-4' },
  ];
  for (const { spec, label } of valid) {
    it(`encodes to ${label}`, () => {
      expect(encodeEnvLabel(spec)).toEqual({ label, error: null });
    });
  }

  const invalid: Array<{ name: string; spec: unknown }> = [
    { name: 'unknown repo', spec: [{ repo: 'unknown-repo', pr: 4 }] },
    { name: 'pr 0', spec: [{ repo: 'lfx-v2-newsletter-service', pr: 0 }] },
    { name: 'pr 100000', spec: [{ repo: 'lfx-v2-newsletter-service', pr: 100000 }] },
    { name: 'pr non-integer', spec: [{ repo: 'lfx-v2-newsletter-service', pr: 1.5 }] },
    { name: 'empty spec', spec: [] },
    { name: 'branch with ..', spec: [{ repo: 'lfx-v2-newsletter-service', branch: '../evil' }] },
    { name: 'branch leading -', spec: [{ repo: 'lfx-v2-newsletter-service', branch: '-lead' }] },
    { name: 'branch non-ascii', spec: [{ repo: 'lfx-v2-newsletter-service', branch: 'ÜÑ' }] },
    { name: 'entry with neither pr nor branch', spec: [{ repo: 'lfx-v2-newsletter-service' }] },
    { name: 'non-object entry', spec: ['x'] },
    { name: 'non-array spec', spec: { repo: 'lfx-v2-newsletter-service', pr: 1 } },
    {
      name: 'overflow (75 chars > 54) — h- labels are a later phase',
      spec: [
        { repo: 'lfx-self-serve', pr: 11111 },
        { repo: 'lfx-v2-newsletter-service', pr: 22222 },
        { repo: 'lfx-self-serve', pr: 33333 },
        { repo: 'lfx-v2-newsletter-service', pr: 44444 },
      ],
    },
  ];
  for (const { name, spec } of invalid) {
    it(`rejects ${name}`, () => {
      const r = encodeEnvLabel(spec);
      expect(r.label).toBeNull();
      expect(typeof r.error).toBe('string');
    });
  }

  it('never echoes raw request values in error strings (JSON/HTML-injection posture)', () => {
    const hostile = '"</script><img src=x onerror=alert(1)>';
    const cases = [
      [{ repo: hostile, pr: 1 }],
      [{ repo: 'lfx-v2-newsletter-service', branch: `${hostile}..` }],
    ];
    for (const spec of cases) {
      const r = encodeEnvLabel(spec);
      expect(r.label).toBeNull();
      expect(r.error).not.toContain(hostile);
      expect(r.error).not.toContain('</script>');
    }
  });
});

describe('parseEnvLabel — pinned against lfx-envlabel.py parse', () => {
  it('parses a single-PR label', () => {
    expect(parseEnvLabel('lfx--newsletter-80')).toEqual({
      spec: [{ repo: 'lfx-v2-newsletter-service', pr: 80 }], error: null,
    });
  });
  it('parses a cross-repo label', () => {
    expect(parseEnvLabel('lfx--self-serve-1688--newsletter-63')).toEqual({
      spec: [{ repo: 'lfx-self-serve', pr: 1688 }, { repo: 'lfx-v2-newsletter-service', pr: 63 }], error: null,
    });
  });
  it('parses a same-repo multi-PR group in order', () => {
    expect(parseEnvLabel('lfx--newsletter-63-71')).toEqual({
      spec: [{ repo: 'lfx-v2-newsletter-service', pr: 63 }, { repo: 'lfx-v2-newsletter-service', pr: 71 }], error: null,
    });
  });
  it('parses a branch group to a lossy slug (exact ref lives in the registry)', () => {
    expect(parseEnvLabel('lfx--newsletter-b-feat-send-retry')).toEqual({
      spec: [{ repo: 'lfx-v2-newsletter-service', slug: 'feat-send-retry' }], error: null,
    });
  });
  const bad = [
    'lfx--h-abcdef0123',       // overflow form needs the registry
    'gatewaze--gw-3',          // wrong project prefix
    'lfx--newsletter-',        // trailing hyphen → not a DNS label
    'lfx--bogus-7',            // unknown alias
    'lfx--newsletter-80-',     // trailing hyphen
    'Lfx--newsletter-80',      // uppercase
    'lfx--newsletter-0',       // pr 0
    '',                        // empty
  ];
  for (const label of bad) {
    it(`rejects ${JSON.stringify(label)}`, () => {
      const r = parseEnvLabel(label);
      expect(r.spec).toBeNull();
      expect(typeof r.error).toBe('string');
    });
  }
  it('round-trips every pure-PR label through encode', () => {
    for (const label of ['lfx--newsletter-80', 'lfx--self-serve-1688--newsletter-63', 'lfx--newsletter-63-71', 'lfx--newsletter-5--self-serve-3--newsletter-7']) {
      const { spec } = parseEnvLabel(label);
      expect(encodeEnvLabel(spec as unknown[])).toEqual({ label, error: null });
    }
  });
});

describe('envTierCheck — phase-1 policy (messages mirror the host agent verbatim)', () => {
  it('passes a Tier-A spec', () => {
    expect(envTierCheck([{ repo: 'lfx-self-serve' }, { repo: 'lfx-v2-newsletter-service' }])).toBeNull();
  });
  it('rejects Tier-B queue-group subscribers with the agent explanation', () => {
    const msg = envTierCheck([{ repo: 'lfx-v2-email-service' }]);
    expect(msg).toContain('Tier-B NATS queue-group subscriber');
    expect(msg).toContain('primary slot');
  });
  it('rejects helm with the shared-cluster explanation', () => {
    expect(envTierCheck([{ repo: 'lfx-v2-helm' }])).toContain('SHARED cluster');
  });
});

describe('slugifyBranch', () => {
  it('matches the Python slugify on the pinned cases', () => {
    expect(slugifyBranch('feat/send-retry')).toBe('feat-send-retry');
    expect(slugifyBranch('dan/WIP_thing--x')).toBe('dan-wip-thing-x');
    expect(slugifyBranch('feature/a-very-long-branch-name-here')).toBe('feature-a-very-long');
    expect(slugifyBranch('---')).toBe('');
  });
});

describe('constants', () => {
  it('keeps the 54-char companion-headroom cap (spec §2.5)', () => {
    expect(ENV_MAX_LABEL).toBe(54);
  });
});
