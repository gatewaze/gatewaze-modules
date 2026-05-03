import { describe, expect, it } from 'vitest';
import {
  pageBranchSlug,
  compactTimestamp,
  buildBranchName,
  checkRemoteAgainstAllowlist,
} from '../branch-slug.js';

describe('pageBranchSlug()', () => {
  it("returns 'home' for the root path", () => {
    expect(pageBranchSlug('/')).toBe('home');
  });

  it("returns 'home' for paths that collapse to all dashes", () => {
    expect(pageBranchSlug('/-/')).toBe('home');
    expect(pageBranchSlug('/@')).toBe('home');
  });

  it('strips leading slash and replaces internal slashes', () => {
    expect(pageBranchSlug('/about')).toBe('about');
    expect(pageBranchSlug('/for/developer')).toBe('for-developer');
  });

  it('lowercases', () => {
    expect(pageBranchSlug('/About')).toBe('about');
    expect(pageBranchSlug('/CamelCase')).toBe('camelcase');
  });

  it('replaces non-[a-z0-9-] characters with dashes', () => {
    expect(pageBranchSlug('/foo bar')).toBe('foo-bar');
    expect(pageBranchSlug('/email@host')).toBe('email-host');
    expect(pageBranchSlug('/100%off')).toBe('100-off');
  });

  it('collapses runs of dashes', () => {
    expect(pageBranchSlug('/foo---bar')).toBe('foo-bar');
    expect(pageBranchSlug('/foo  bar')).toBe('foo-bar');
  });

  it('trims leading and trailing dashes', () => {
    expect(pageBranchSlug('/-foo-')).toBe('foo');
    expect(pageBranchSlug('/--foo--')).toBe('foo');
  });

  it('truncates at 40 characters', () => {
    const long = '/blog/2026/article-with-very-long-name-that-overflows';
    const slug = pageBranchSlug(long);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.startsWith('blog-2026-')).toBe(true);
  });

  it("matches the spec's worked example for /blog/2026/article-with-very-long-name-that-overflows", () => {
    // Per spec §6.2 example, the page-branch-slug component is the first 40
    // chars of the dashed-and-collapsed form: "blog-2026-article-with-very-long-name-th".
    expect(pageBranchSlug('/blog/2026/article-with-very-long-name-that-overflows')).toBe(
      'blog-2026-article-with-very-long-name-th',
    );
  });
});

describe('compactTimestamp()', () => {
  it('formats UTC YYYYMMDDHHMMSS deterministically', () => {
    expect(compactTimestamp(new Date('2026-05-01T14:30:22Z'))).toBe('20260501143022');
  });

  it('zero-pads single-digit fields', () => {
    expect(compactTimestamp(new Date('2026-01-02T03:04:05Z'))).toBe('20260102030405');
  });
});

describe('buildBranchName()', () => {
  const ts = new Date('2026-05-01T14:30:22Z');

  it("matches spec example for / (id abc12345-...)", () => {
    expect(
      buildBranchName({
        fullPath: '/',
        pageId: 'abc12345-1111-2222-3333-444444444444',
        publishId: 'a3f9c2b1-aaaa-bbbb-cccc-dddddddddddd',
        timestamp: ts,
      }),
    ).toBe('content/home-abc12345/20260501143022-a3f9c2b1');
  });

  it('matches spec example for /for/developer', () => {
    expect(
      buildBranchName({
        fullPath: '/for/developer',
        pageId: 'def67890-1111-2222-3333-444444444444',
        publishId: 'a3f9c2b1-aaaa-bbbb-cccc-dddddddddddd',
        timestamp: ts,
      }),
    ).toBe('content/for-developer-def67890/20260501143022-a3f9c2b1');
  });

  it('matches spec example for the long /blog/.../that-overflows', () => {
    expect(
      buildBranchName({
        fullPath: '/blog/2026/article-with-very-long-name-that-overflows',
        pageId: '9876fedc-1111-2222-3333-444444444444',
        publishId: 'a3f9c2b1-aaaa-bbbb-cccc-dddddddddddd',
        timestamp: ts,
      }),
    ).toBe('content/blog-2026-article-with-very-long-name-th-9876fedc/20260501143022-a3f9c2b1');
  });

  it("yields different branch names when only pageId differs (collision avoidance)", () => {
    const a = buildBranchName({
      fullPath: '/blog/2026/article-with-very-long-name-and-more-overflowing-stuff',
      pageId: '11111111-1111-2222-3333-444444444444',
      publishId: 'a3f9c2b1-aaaa-bbbb-cccc-dddddddddddd',
      timestamp: ts,
    });
    const b = buildBranchName({
      fullPath: '/blog/2026/article-with-very-long-name-and-more-overflowing-stuff',
      pageId: '22222222-1111-2222-3333-444444444444',
      publishId: 'a3f9c2b1-aaaa-bbbb-cccc-dddddddddddd',
      timestamp: ts,
    });
    expect(a).not.toBe(b);
  });

  it('stays comfortably under git ref length limit (255 bytes)', () => {
    const branch = buildBranchName({
      fullPath: '/' + 'x'.repeat(200), // pathological input
      pageId: '11111111-1111-2222-3333-444444444444',
      publishId: 'a3f9c2b1-aaaa-bbbb-cccc-dddddddddddd',
      timestamp: ts,
    });
    expect(branch.length).toBeLessThan(100);
    expect(branch.startsWith('content/')).toBe(true);
  });
});

describe('checkRemoteAgainstAllowlist()', () => {
  it('accepts any remote when allowlist is empty', () => {
    const result = checkRemoteAgainstAllowlist('https://github.com/user/repo.git', []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.host).toBe('github.com');
  });

  it('accepts a remote whose host is on the allowlist', () => {
    const result = checkRemoteAgainstAllowlist('https://github.com/user/repo.git', ['github.com']);
    expect(result.ok).toBe(true);
  });

  it('rejects a remote whose host is NOT on the allowlist', () => {
    const result = checkRemoteAgainstAllowlist('https://evil.example/repo.git', ['github.com']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('egress_blocked');
      expect(result.host).toBe('evil.example');
    }
  });

  it('parses git@host:owner/repo.git form', () => {
    const result = checkRemoteAgainstAllowlist('git@github.com:user/repo.git', ['github.com']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.host).toBe('github.com');
  });

  it('compares hostnames case-insensitively', () => {
    const result = checkRemoteAgainstAllowlist('https://GitHub.com/user/repo.git', ['github.com']);
    expect(result.ok).toBe(true);
  });

  it('returns malformed_remote_url for an unparseable remote', () => {
    const result = checkRemoteAgainstAllowlist('not a url', ['github.com']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed_remote_url');
  });
});
