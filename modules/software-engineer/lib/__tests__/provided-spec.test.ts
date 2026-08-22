// @ts-nocheck — vitest harness; the lib is @ts-nocheck'd already.
//
// Locally-authored spec handoff: label parsing + body extraction (lib/provided-spec.ts).
// The extraction contract intake relies on: markers preferred over the heading, unclosed
// markers fail loud (no silent heading fallback), empty/missing/oversize sections error,
// and the returned text is content-sanitised (NULs stripped, CRLF normalised) but otherwise
// verbatim — the spec is data, never config.
import { describe, it, expect } from 'vitest';
import {
  parseSpecLabels, extractProvidedSpec,
  SPEC_PROVIDED_LABEL, SPEC_APPROVED_LABEL, MAX_PROVIDED_SPEC_BYTES,
} from '../provided-spec.js';

describe('parseSpecLabels', () => {
  it('detects the provided and approved labels independently', () => {
    expect(parseSpecLabels([SPEC_PROVIDED_LABEL])).toEqual({ provided: true, approved: false });
    expect(parseSpecLabels([SPEC_APPROVED_LABEL])).toEqual({ provided: false, approved: true });
    expect(parseSpecLabels([SPEC_PROVIDED_LABEL, SPEC_APPROVED_LABEL])).toEqual({ provided: true, approved: true });
  });

  it('is exact-match: prefixed/suffixed/namespaced labels are NOT spec labels', () => {
    expect(parseSpecLabels(['agent:spec:provided-v2', 'xagent:spec:provided', 'agent:spec', 'agent:spec:providedX']))
      .toEqual({ provided: false, approved: false });
  });

  it('tolerates case, whitespace, and junk entries', () => {
    expect(parseSpecLabels([' Agent:Spec:Provided ', null, undefined, 42, 'bug']))
      .toEqual({ provided: true, approved: false });
  });

  it('returns false/false for empty or missing input', () => {
    expect(parseSpecLabels([])).toEqual({ provided: false, approved: false });
    expect(parseSpecLabels(undefined)).toEqual({ provided: false, approved: false });
  });
});

describe('extractProvidedSpec — markers', () => {
  it('extracts everything between the markers', () => {
    const body = 'Intro prose.\n<!-- se:spec -->\n# Goal\nDo the thing.\n<!-- /se:spec -->\nOutro.';
    expect(extractProvidedSpec(body)).toEqual({ spec: '# Goal\nDo the thing.', source: 'markers' });
  });

  it('prefers markers over a ## Spec heading when both are present', () => {
    const body = '## Spec\nheading version\n\n<!-- se:spec -->marker version<!-- /se:spec -->';
    expect(extractProvidedSpec(body)).toEqual({ spec: 'marker version', source: 'markers' });
  });

  it('tolerates marker whitespace and case', () => {
    const body = '<!--se:spec-->x<!--  /se:spec  -->';
    expect(extractProvidedSpec(body)).toEqual({ spec: 'x', source: 'markers' });
  });

  it('fails loud on an unclosed opening marker — no silent fallback to heading mode', () => {
    const body = '<!-- se:spec -->\nspec text\n\n## Spec\nheading text';
    const r = extractProvidedSpec(body);
    expect(r.error).toMatch(/without a closing/);
  });

  it('errors when the fenced section is empty', () => {
    const r = extractProvidedSpec('<!-- se:spec -->\n   \n<!-- /se:spec -->');
    expect(r.error).toMatch(/empty/);
  });
});

describe('extractProvidedSpec — heading', () => {
  it('takes everything under ## Spec to the next h2', () => {
    const body = '# Issue\nprose\n\n## Spec\nGoal: fix it.\nApproach: carefully.\n\n## Notes\nnot spec';
    expect(extractProvidedSpec(body)).toEqual({ spec: 'Goal: fix it.\nApproach: carefully.', source: 'heading' });
  });

  it('takes everything to EOF when no later heading exists, and keeps ### subsections', () => {
    const body = '## Spec\nIntro.\n### Details\nMore.';
    expect(extractProvidedSpec(body)).toEqual({ spec: 'Intro.\n### Details\nMore.', source: 'heading' });
  });

  it('stops at an h1 too (same-or-higher level terminates)', () => {
    const body = '## Spec\nonly this\n# Appendix\nnope';
    expect(extractProvidedSpec(body)).toEqual({ spec: 'only this', source: 'heading' });
  });

  it('matches the heading case-insensitively with an optional colon, but not prose containing "spec"', () => {
    expect(extractProvidedSpec('## SPEC:\nx')).toEqual({ spec: 'x', source: 'heading' });
    expect(extractProvidedSpec('## Spec review notes\nx').error).toMatch(/no spec section/);
  });

  it('errors when the heading section is empty', () => {
    expect(extractProvidedSpec('## Spec\n\n## Next\nx').error).toMatch(/empty/);
  });
});

describe('extractProvidedSpec — validation', () => {
  it('errors on a body with no spec section, an empty body, and a non-string body', () => {
    expect(extractProvidedSpec('just an ordinary issue').error).toMatch(/no spec section/);
    expect(extractProvidedSpec('').error).toMatch(/no spec section/);
    expect(extractProvidedSpec(null).error).toMatch(/no spec section/);
    expect(extractProvidedSpec({ evil: true }).error).toMatch(/no spec section/);
  });

  it('rejects an oversize spec instead of truncating it', () => {
    const big = 'x'.repeat(MAX_PROVIDED_SPEC_BYTES + 1);
    const r = extractProvidedSpec(`<!-- se:spec -->${big}<!-- /se:spec -->`);
    expect(r.error).toMatch(/exceeds the 64KB cap/);
  });

  it('accepts a spec right at the cap', () => {
    const max = 'x'.repeat(MAX_PROVIDED_SPEC_BYTES);
    const r = extractProvidedSpec(`<!-- se:spec -->${max}<!-- /se:spec -->`);
    expect(r).toMatchObject({ source: 'markers' });
    expect(r.spec.length).toBe(MAX_PROVIDED_SPEC_BYTES);
  });

  it('strips NUL bytes and normalises CRLF, but otherwise keeps the text verbatim (content, not config)', () => {
    const r = extractProvidedSpec('<!-- se:spec -->line1\u0000\r\nline2 <script>alert(1)</script>\r\n<!-- /se:spec -->');
    expect(r).toEqual({ spec: 'line1\nline2 <script>alert(1)</script>', source: 'markers' });
  });
});
