// enqueueRun picks the full-sweep FeedScraper row when focused rows also exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueRun } from '../lib/sources.ts';

function fakeSb(rows) {
  const rpcCalls = [];
  const q = { select() { return q; }, eq() { return q; }, order() { return Promise.resolve({ data: rows, error: null }); } };
  return { rpcCalls, from: () => q, rpc: async (fn, args) => { rpcCalls.push(args); return { data: [{ job_id: 7 }], error: null }; } };
}

test('admin runs use the full-sweep row, not a focused one', async () => {
  const sb = fakeSb([
    { id: 239, name: 'Discovery feeds', scraper_type: 'FeedScraper', event_type: 'blog', config: {} },
    { id: 241, name: 'Agentic AI feeds (focused)', scraper_type: 'FeedScraper', event_type: 'blog', config: { source_ids: ['x'] } },
  ]);
  const added = [];
  await enqueueRun(sb, async (t, d) => { added.push(d); return { id: 1 }; }, { createdBy: 'admin:test' });
  assert.deepEqual(sb.rpcCalls[0].scraper_ids, [239]);
  assert.equal(added[0].scraperId, 239);
});

test('focused rows listed first still lose to the full-sweep row', async () => {
  const sb = fakeSb([
    { id: 5, name: 'Focused', scraper_type: 'FeedScraper', event_type: 'blog', config: { source_ids: ['x'] } },
    { id: 9, name: 'Discovery feeds', scraper_type: 'FeedScraper', event_type: 'blog', config: null },
  ]);
  await enqueueRun(sb, async () => ({ id: 1 }), { createdBy: 'admin:test' });
  assert.deepEqual(sb.rpcCalls[0].scraper_ids, [9]);
});
