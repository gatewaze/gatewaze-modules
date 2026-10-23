import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryBlurb, oneSentence, isReleaseTitle, excerptForStorage } from '../lib/blurb.js';

// Rows lifted from samples/2026-09-21/blog_digest_compact.md in the harvest bundle.
test('first sentence, 40-char floor, 150 cap with ellipsis', () => {
  assert.equal(
    oneSentence('New MaterialX Teapot and Lion assets created by NVIDIA are now available for download through DPEL! More text.'),
    'New MaterialX Teapot and Lion assets created by NVIDIA are now available for download through DPEL!',
  );
  const long = 'AAIF community members gathered in Shanghai to discuss open source agents, safety frameworks, messaging infrastructure, edge computing, and agent memory and more words';
  const b = oneSentence(long);
  assert.ok(b.length <= 151 && b.endsWith('…'));
  assert.equal(oneSentence('Short. Then a much longer second sentence follows here.'), 'Short. Then a much longer second sentence follows here.');
});

test('release titles get no blurb', () => {
  assert.equal(isReleaseTitle('Node.js 26.9.0 (Current)'), true);
  assert.equal(isReleaseTitle('Announcing Istio 1.31.1'), true);
  assert.equal(isReleaseTitle('Support for Istio 1.29 ends on the 12th of October, 2026'), true);
  assert.equal(isReleaseTitle('Keeping up with AI: Valkey security in 2026'), false);
  assert.equal(entryBlurb({ title: 'Keycloak 26.7.4 released', excerpt: 'Keycloak 26.7.4 is out with fixes.' }), '');
});

test('junk and title-repeat suppression', () => {
  assert.equal(entryBlurb({ title: 'X', excerpt: 'The post Something appeared first on CNCF.' }), '');
  assert.equal(entryBlurb({ title: 'Agent Router Joins AAIF', excerpt: 'Agent Router joins AAIF.' }), '');
  assert.equal(entryBlurb({ title: 'DIF Newsletter #65', excerpt: 'Table of contents Welcome' }), '');
});

test('boilerplate prefixes stripped; og:description fallback used when excerpt empty', () => {
  assert.equal(
    entryBlurb({ title: 'Something', excerpt: 'TL;DR Coding agents can generate software faster than teams can verify it.' }),
    'Coding agents can generate software faster than teams can verify it.',
  );
  assert.equal(
    entryBlurb({ title: 'Agent Router: Powerful Traffic Handling', excerpt: '' }, 'Agent Router gives agent builders proven Envoy traffic handling without proxy expertise.'),
    'Agent Router gives agent builders proven Envoy traffic handling without proxy expertise.',
  );
});

test('excerptForStorage truncates at 220 on a word boundary', () => {
  const e = excerptForStorage('<p>' + 'word '.repeat(80) + '</p>');
  assert.ok(e.length <= 221 && e.endsWith('…'));
  assert.equal(excerptForStorage('short <b>bold</b>'), 'short bold');
});
