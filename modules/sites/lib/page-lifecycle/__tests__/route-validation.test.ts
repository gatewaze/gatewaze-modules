import { describe, expect, it } from 'vitest';
import { normalizeRoute, joinRoute } from '../route-validation.js';

describe('normalizeRoute()', () => {
  it('accepts a single-segment path', () => {
    const r = normalizeRoute('/about');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe('/about');
    expect(r.segments).toEqual(['about']);
    expect(r.isHomepage).toBe(false);
  });

  it("treats '/' as the homepage", () => {
    const r = normalizeRoute('/');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe('/');
    expect(r.segments).toEqual([]);
    expect(r.isHomepage).toBe(true);
  });

  it('collapses duplicate slashes and strips trailing slash', () => {
    const r = normalizeRoute('//foo///bar/');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe('/foo/bar');
  });

  it('rejects paths that do not start with /', () => {
    const r = normalizeRoute('about');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('must_start_with_slash');
  });

  it('rejects empty / non-string', () => {
    expect(normalizeRoute('').ok).toBe(false);
    expect(normalizeRoute(null).ok).toBe(false);
    expect(normalizeRoute(undefined).ok).toBe(false);
    expect(normalizeRoute(42).ok).toBe(false);
  });

  it('rejects ..', () => {
    const r = normalizeRoute('/foo/../bar');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('contains_dotdot');
  });

  it('rejects null bytes', () => {
    const r = normalizeRoute('/foo\0bar');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('contains_null');
  });

  it('rejects query strings and fragments', () => {
    expect((normalizeRoute('/foo?x=1') as { reason: string }).reason).toBe('contains_query_or_fragment');
    expect((normalizeRoute('/foo#bar') as { reason: string }).reason).toBe('contains_query_or_fragment');
  });

  it('rejects invalid segments', () => {
    const r = normalizeRoute('/foo/bar baz');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid_segment');
  });

  it('caps length', () => {
    const r = normalizeRoute('/' + 'a'.repeat(3000));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('too_long');
  });
});

describe('joinRoute()', () => {
  it('joins parent and child', () => {
    const r = joinRoute('/blog', 'post-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe('/blog/post-1');
  });

  it("joins '/' parent without producing '//'", () => {
    const r = joinRoute('/', 'about');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe('/about');
  });

  it('rejects child slug that contains /', () => {
    const r = joinRoute('/blog', 'foo/bar');
    expect(r.ok).toBe(false);
  });

  it('rejects empty child slug', () => {
    const r = joinRoute('/blog', '');
    expect(r.ok).toBe(false);
  });

  it('rejects .. as child slug', () => {
    const r = joinRoute('/blog', '..');
    expect(r.ok).toBe(false);
  });
});
