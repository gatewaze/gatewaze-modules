// Activation rules for a new discovery source (lib/sources.ts submit). Node
// strips the TypeScript types natively (Node >= 22.18), so this imports the
// .ts directly. feed_url is always given or kind is html, so submit never
// reaches the network resolver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submit, patch, shouldActivate, SourceError } from '../lib/sources.ts';

/**
 * Minimal fake: selects return `selectRow` (null = nothing tracked yet; for
 * patch, the row's current kind), inserts and updates are recorded and echo
 * their payload back.
 */
function fakeSb({ selectRow = null } = {}) {
  const inserts = [];
  const updates = [];
  const chain = (result) => {
    const self = {
      select: () => self, eq: () => self, ilike: () => self,
      limit: () => Promise.resolve({ data: [], error: null }),
      maybeSingle: () => Promise.resolve({ data: result, error: null }),
      single: () => Promise.resolve({ data: result, error: null }),
    };
    return self;
  };
  return {
    inserts, updates,
    from: () => ({
      select: () => chain(selectRow),
      insert: (row) => { inserts.push(row); return chain({ ...row }); },
      update: (row) => { updates.push(row); return chain({ id: 'x', ...row }); },
    }),
  };
}

const admin = { personId: null, addedVia: 'api', isAdmin: true };
const user = { ...admin, isAdmin: false };
const FEED = { site_url: 'https://example.org/', feed_url: 'https://example.org/feed/' };

async function statusOf(input, ctx) {
  const sb = fakeSb();
  await submit(sb, input, ctx);
  return sb.inserts[0].status;
}

test('a non-admin always lands pending', async () => {
  assert.equal(await statusOf(FEED, user), 'pending');
  assert.equal(await statusOf({ ...FEED, kind: 'sitemap', path_prefix: 'https://example.org/blog/' }, user), 'pending');
});

test('an admin activates a same-domain feed or sitemap', async () => {
  assert.equal(await statusOf(FEED, admin), 'active');
  assert.equal(await statusOf({ ...FEED, kind: 'sitemap', path_prefix: 'https://example.org/blog/' }, admin), 'active');
  // a subdomain is the same registrable domain
  assert.equal(await statusOf({ site_url: 'https://example.org/', feed_url: 'https://blog.example.org/feed/' }, admin), 'active');
});

test('as_pending forces pending even for an admin', async () => {
  assert.equal(await statusOf({ ...FEED, as_pending: true }, admin), 'pending');
  // only a real boolean counts
  assert.equal(await statusOf({ ...FEED, as_pending: 'true' }, admin), 'active');
});

test('a cross-domain feed_url stays pending even when an admin chose it, and says why', async () => {
  const sb = fakeSb();
  await submit(sb, { site_url: 'https://example.org/', feed_url: 'https://medium.com/feed/example' }, admin);
  assert.equal(sb.inserts[0].status, 'pending');
  assert.match(sb.inserts[0].note, /different domain/);
});

test('an html source stays pending, with or without an extractor id', async () => {
  assert.equal(await statusOf({ site_url: 'https://example.org/', kind: 'html' }, admin), 'pending');
  assert.equal(await statusOf({ site_url: 'https://example.org/', kind: 'html', scraper_id: 'some-extractor' }, admin), 'pending');
});

test('shouldActivate truth table', () => {
  const base = { kind: 'feed', crossDomain: false, isAdmin: true, asPending: false };
  assert.equal(shouldActivate(base), true);
  assert.equal(shouldActivate({ ...base, isAdmin: false }), false);
  assert.equal(shouldActivate({ ...base, asPending: true }), false);
  assert.equal(shouldActivate({ ...base, crossDomain: true }), false);
  assert.equal(shouldActivate({ ...base, kind: 'html' }), false);
  assert.equal(shouldActivate({ ...base, kind: 'sitemap' }), true);
});

test('patch refuses to activate an html row; other kinds activate', async () => {
  const id = '0b1c9a5e-3f2a-4d6b-9c1e-2a3b4c5d6e7f';
  await assert.rejects(() => patch(fakeSb({ selectRow: { kind: 'html' } }), id, { status: 'active' }), (e) => e instanceof SourceError && /html/.test(e.message));
  await assert.rejects(() => patch(fakeSb({ selectRow: { kind: 'feed' } }), id, { status: 'active', kind: 'html' }), /html/);
  const sb = fakeSb({ selectRow: { kind: 'feed' } });
  await patch(sb, id, { status: 'active' });
  assert.equal(sb.updates[0].status, 'active');
});
