import { describe, it, expect } from 'vitest';
import { specForPrompt, SPEC_PROMPT_LIMIT } from '../spec-prompt.js';

describe('specForPrompt', () => {
  it('passes a spec the size of the ones that failed through whole', () => {
    // Runs #94 and #98 had specs of about 38,700 characters and were cut at
    // 20,000, inside §5.3. The longest spec seen on staging was 54,952.
    for (const size of [38_684, 54_952]) {
      const spec = `${'x'.repeat(size - 9)}§5.3 end.`;
      const out = specForPrompt(spec);
      expect(out).toBe(spec);
      expect(out.endsWith('§5.3 end.')).toBe(true);
      expect(out).not.toContain('SPEC TRUNCATED');
    }
  });

  it('says so when it does have to cut, rather than ending mid-sentence', () => {
    const spec = 'a'.repeat(SPEC_PROMPT_LIMIT + 1234);
    const out = specForPrompt(spec);
    expect(out.startsWith('a'.repeat(SPEC_PROMPT_LIMIT))).toBe(true);
    expect(out).toContain('SPEC TRUNCATED');
    expect(out).toContain('1,234 characters');
    expect(out).toContain('Do not treat this point as the end of the requirements');
  });

  it('honours a smaller limit, so the notice can be checked without a huge string', () => {
    const out = specForPrompt('abcdefghij', 4);
    expect(out.startsWith('abcd\n\n[SPEC TRUNCATED')).toBe(true);
    expect(out).toContain('6 characters');
  });

  it('treats a missing artifact as an empty spec, as the inline slice did', () => {
    expect(specForPrompt(undefined)).toBe('');
    expect(specForPrompt(null)).toBe('');
  });
});
