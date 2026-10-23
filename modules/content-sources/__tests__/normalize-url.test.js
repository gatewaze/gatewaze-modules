import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, canonicalForStorage, slugForPost, registrableDomain, hostOf } from '../lib/normalize-url.js';

// These cases are pinned in migrations/001 as well; the SQL and JS twins must agree.
test('normalizeUrl: scheme, www, trailing slash, fragment, tracking params, sorted params', () => {
  assert.equal(normalizeUrl('http://www.Example.org/blog/post-1/?utm_source=x&b=2&a=1#frag'), 'example.org/blog/post-1?a=1&b=2');
  assert.equal(normalizeUrl('https://example.org/blog/post-1'), normalizeUrl('http://www.example.org/blog/post-1/'));
  assert.equal(normalizeUrl('https://wp.example.org/?p=123&utm_medium=m'), 'wp.example.org?p=123');
  assert.equal(normalizeUrl('https://example.org/'), 'example.org');
  assert.equal(normalizeUrl('not a url at all'), 'not a url at all');
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl('https://a.org/x?ref=rss&fbclid=1&gclid=2&source=s'), 'a.org/x');
});

test('canonicalForStorage: https, no fragment, tracking removed, else null', () => {
  assert.equal(canonicalForStorage('http://Example.org/a/?utm_source=x&keep=1#f'), 'https://example.org/a/?keep=1');
  assert.equal(canonicalForStorage('ftp://example.org/a'), null);
  assert.equal(canonicalForStorage('https://user:pw@example.org/a'), null);
  assert.equal(canonicalForStorage('nope'), null);
});

test('slugForPost: host--path, hash for empty or numeric paths, hash suffix when truncated', () => {
  assert.equal(slugForPost('https://www.cncf.io/blog/2026/09/17/opentelemetry-everywhere/'), 'cncf-io--blog-2026-09-17-opentelemetry-everywhere');
  assert.match(slugForPost('https://wp.example.org/?p=123'), /^wp-example-org--[0-9a-f]{8}$/);
  assert.match(slugForPost('https://example.org/2026/09/17/'), /^example-org--[0-9a-f]{8}$/);
  assert.notEqual(slugForPost('https://wp.example.org/?p=123'), slugForPost('https://wp.example.org/?p=124'));
  const long = 'https://example.org/' + 'a'.repeat(600);
  const s = slugForPost(long);
  assert.ok(s.length <= 500);
  assert.match(s, /-[0-9a-f]{8}$/);
  assert.equal(slugForPost('https://example.org/post.html'), 'example-org--post');
});

test('registrableDomain + hostOf', () => {
  assert.equal(registrableDomain('blog.example.org'), 'example.org');
  assert.equal(registrableDomain('www.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('example.org'), 'example.org');
  assert.equal(hostOf('https://WWW.Example.org/x'), 'example.org');
  assert.equal(hostOf('nope'), '');
});
