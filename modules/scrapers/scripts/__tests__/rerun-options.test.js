import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rerunOptionsFromMetadata } from '../../api.ts';

const A = '0b1c9a5e-3f2a-4d6b-9c1e-2a3b4c5d6e7f';
const B = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

test('a FeedScraper job carries its source_ids over', () => {
  assert.deepEqual(rerunOptionsFromMetadata('FeedScraper', { source_ids: [A, B] }), { source_ids: [A, B] });
  assert.deepEqual(rerunOptionsFromMetadata('FeedScraper', { source_ids: [A, A] }), { source_ids: [A] });
});

test('other scrapers never get options from metadata', () => {
  assert.equal(rerunOptionsFromMetadata('LumaICalScraper', { source_ids: [A] }), undefined);
});

test('anything that is not 1-100 uuid strings yields a normal run', () => {
  for (const md of [null, undefined, 'x', [A], {}, { source_ids: [] }, { source_ids: A }, { source_ids: [A, 'not-a-uuid'] },
    { source_ids: [A, 5] }, { source_ids: [`${A}' or 1=1`] }, { source_ids: Array.from({ length: 101 }, () => A) }]) {
    assert.equal(rerunOptionsFromMetadata('FeedScraper', md), undefined, JSON.stringify(md));
  }
});

test('only source_ids is carried, never other keys', () => {
  assert.deepEqual(rerunOptionsFromMetadata('FeedScraper', { source_ids: [A], evil: true }), { source_ids: [A] });
});
