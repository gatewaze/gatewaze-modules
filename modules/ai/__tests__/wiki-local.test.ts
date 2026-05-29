import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  upsertPageLocal, readPageLocal, listPagesLocal, searchPagesLocal,
} from '../lib/wiki/local-repo.js';

describe('local filesystem wiki backend', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wiki-local-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('round-trips a hierarchical page through the filesystem', () => {
    const up = upsertPageLocal(root, {
      slug: 'conferences/mumbai/submissions/1208848',
      title: 'MCP at Scale',
      body: 'Gateway talk. See [[meta/topics/gateways]].',
      summary: 'gateway',
      category: 'submissions',
      metadata: { disposition: 'keep' },
    });
    expect(up.ok).toBe(true);
    const page = readPageLocal(root, 'conferences/mumbai/submissions/1208848')!;
    expect(page.title).toBe('MCP at Scale');
    expect(page.metadata).toEqual({ disposition: 'keep' });
    expect(page.links).toContain('meta/topics/gateways');
  });

  it('rejects an invalid slug without writing', () => {
    const up = upsertPageLocal(root, { slug: 'Bad Slug', title: 'T', body: 'B' });
    expect(up.ok).toBe(false);
    expect(readPageLocal(root, 'Bad Slug')).toBeNull();
  });

  it('lists by path prefix and metadata where-filter', () => {
    upsertPageLocal(root, { slug: 'conferences/mumbai/submissions/1', title: 'A', body: 'x', metadata: { disposition: 'keep' } });
    upsertPageLocal(root, { slug: 'conferences/mumbai/submissions/2', title: 'B', body: 'y', metadata: { disposition: 'reject' } });
    upsertPageLocal(root, { slug: 'meta/trends/mcp', title: 'C', body: 'z' });

    expect(listPagesLocal(root, { prefix: 'conferences/mumbai/submissions' }).map((p) => p.slug)).toEqual([
      'conferences/mumbai/submissions/1', 'conferences/mumbai/submissions/2',
    ]);
    expect(listPagesLocal(root, { where: { disposition: 'keep' } }).map((p) => p.slug)).toEqual(['conferences/mumbai/submissions/1']);
  });

  it('keyword search ranks title hits above body hits', () => {
    upsertPageLocal(root, { slug: 'a', title: 'Gateway architecture', body: 'about scaling' });
    upsertPageLocal(root, { slug: 'b', title: 'Other', body: 'mentions gateway once' });
    upsertPageLocal(root, { slug: 'c', title: 'Unrelated', body: 'nothing here' });
    const results = searchPagesLocal(root, { query: 'gateway' });
    expect(results.map((r) => r.slug)).toEqual(['a', 'b']); // c excluded (score 0)
    expect(results[0]!.slug).toBe('a'); // title hit outranks body hit
  });
});
