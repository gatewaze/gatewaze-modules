import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobCompletionCounts } from '../job-completion-counts.js';

const counters = { processed: 7, skipped: 2, failed: 1 };

test('a streaming scraper that returns [] keeps the handler counters', () => {
  // LumaICalScraper saves through globalConfig.saveEvent and returns [].
  const scraper = { stats: { found: 0, processed: 0 } };
  assert.deepEqual(jobCompletionCounts(scraper, [], counters), { found: 0, total: 0, processed: 7, skipped: 2, failed: 1 });
});

test('a scraper that returns events keeps the handler counters', () => {
  assert.deepEqual(jobCompletionCounts({ stats: { found: 99 } }, [{}, {}, {}], counters), { found: 3, total: 3, processed: 7, skipped: 2, failed: 1 });
});

test('a self-persisting scraper reports its own stats', () => {
  const scraper = {
    selfPersisting: true,
    stats: { found: 10, inserted: 4, processed: 4, skipped: 1, collapsed_url: 2, collapsed_title: 1, owned_elsewhere: 1, failed_items: 1 },
  };
  assert.deepEqual(jobCompletionCounts(scraper, [], counters), { found: 10, total: 10, processed: 4, skipped: 5, failed: 1 });
});

test('selfPersisting must be exactly true', () => {
  const scraper = { selfPersisting: 'yes', stats: { found: 10, inserted: 4 } };
  assert.equal(jobCompletionCounts(scraper, [], counters).processed, 7);
  assert.equal(jobCompletionCounts(null, null, counters).found, 0);
});
