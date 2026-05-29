import { describe, it, expect } from 'vitest';
import { validateSlug, isValidSlug, slugDir, resolveRelativeLink } from '../lib/wiki/slug.js';

describe('validateSlug', () => {
  it('accepts single and multi-segment path slugs', () => {
    expect(isValidSlug('anthropic-news')).toBe(true);
    expect(isValidSlug('conferences/mumbai/submissions/1208848')).toBe(true);
    expect(isValidSlug('meta/trends/mcp')).toBe(true);
    expect(isValidSlug('_lint-report')).toBe(true); // reserved/system slug
    expect(isValidSlug('raw')).toBe(true);
  });
  it('rejects traversal, slashes, empties, bad chars, depth', () => {
    expect(validateSlug('').ok).toBe(false);
    expect(validateSlug('/leading').ok).toBe(false);
    expect(validateSlug('trailing/').ok).toBe(false);
    expect(validateSlug('a//b').ok).toBe(false);
    expect(validateSlug('a/../b').ok).toBe(false);
    expect(validateSlug('..').ok).toBe(false);
    expect(validateSlug('Has Space').ok).toBe(false);
    expect(validateSlug('UPPER').ok).toBe(false);
    expect(validateSlug('a/b/c/d/e/f/g/h/i').ok).toBe(false); // 9 segments > 8
    expect(validateSlug('-leadingdash').ok).toBe(false);
  });
});

describe('slugDir', () => {
  it('returns the directory portion', () => {
    expect(slugDir('a/b/c')).toBe('a/b');
    expect(slugDir('leaf')).toBe('');
  });
});

describe('resolveRelativeLink', () => {
  const from = 'conferences/mumbai/submissions/1208848';
  it('resolves ../ relative .md links to a slug', () => {
    expect(resolveRelativeLink(from, '../speakers/kaiwalya.md')).toBe('conferences/mumbai/speakers/kaiwalya');
    expect(resolveRelativeLink(from, '1208849.md')).toBe('conferences/mumbai/submissions/1208849');
    expect(resolveRelativeLink(from, './notes.md')).toBe('conferences/mumbai/submissions/notes');
  });
  it('strips a leading wiki/ from absolute targets', () => {
    expect(resolveRelativeLink(from, '/wiki/meta/trends/mcp.md')).toBe('meta/trends/mcp');
  });
  it('returns null for external, non-md, or escaping links', () => {
    expect(resolveRelativeLink(from, 'https://example.com/x.md')).toBeNull();
    expect(resolveRelativeLink(from, '../sibling')).toBeNull(); // no .md
    expect(resolveRelativeLink('a', '../../x.md')).toBeNull(); // escapes root
  });
});
