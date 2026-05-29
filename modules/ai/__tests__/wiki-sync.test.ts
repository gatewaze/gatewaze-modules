import { describe, it, expect } from 'vitest';
import { serializePage, parseFrontmatter } from '../lib/wiki/frontmatter.js';
import { decidePull, decidePushFiles } from '../lib/wiki/sync-reconcile.js';

describe('frontmatter round-trip', () => {
  it('serializes reserved keys + metadata and parses them back', () => {
    const md = serializePage({
      slug: 'conferences/mumbai/submissions/1208848',
      title: 'MCP at Scale',
      summary: 'Gateway talk',
      category: 'submissions',
      updatedAt: '2026-04-23T14:00:00.000Z',
      syncedHash: 'abc123',
      metadata: { disposition: 'keep', scores: { total: 18 } },
      body: '## Abstract\nBody text.',
    });
    const p = parseFrontmatter(md);
    expect(p.slug).toBe('conferences/mumbai/submissions/1208848');
    expect(p.title).toBe('MCP at Scale');
    expect(p.summary).toBe('Gateway talk');
    expect(p.syncedHash).toBe('abc123');
    expect(p.metadata).toEqual({ disposition: 'keep', scores: { total: 18 } });
    expect(p.body).toBe('## Abstract\nBody text.');
  });
  it('treats a file with no frontmatter as all body', () => {
    const p = parseFrontmatter('# Just a heading\ntext');
    expect(p.metadata).toEqual({});
    expect(p.body).toBe('# Just a heading\ntext');
  });
  it('reserved keys do not leak into metadata', () => {
    const p = parseFrontmatter('---\ntitle: T\nslug: a/b\ndisposition: keep\n---\nbody');
    expect(p.metadata).toEqual({ disposition: 'keep' });
    expect(p.metadata).not.toHaveProperty('title');
  });
});

describe('decidePull (§7.2 truth table)', () => {
  const row = (contentHash: string, gitSyncedHash: string | null, updatedAt = '2026-01-01T00:00:00Z') => ({ contentHash, gitSyncedHash, updatedAt });

  it('new file in git → create', () => {
    expect(decidePull({ gitHash: 'g', gitCommitTime: 't' }, null).action).toBe('create');
  });
  it('git==db content → noop (loop-break)', () => {
    expect(decidePull({ gitHash: 'h', gitCommitTime: 't' }, row('h', 'h')).action).toBe('noop');
  });
  it('only git dirty → accept_git', () => {
    // db clean (content==synced), git changed
    expect(decidePull({ gitHash: 'gNew', gitCommitTime: 't' }, row('base', 'base')).action).toBe('accept_git');
  });
  it('only db dirty → db_wins_skip', () => {
    // git hash == synced (git unchanged), db content differs from synced
    expect(decidePull({ gitHash: 'base', gitCommitTime: 't' }, row('dbNew', 'base')).action).toBe('db_wins_skip');
  });
  it('both dirty → conflict, last-writer-wins', () => {
    const gitNewer = decidePull({ gitHash: 'gNew', gitCommitTime: '2026-06-01T00:00:00Z' }, row('dbNew', 'base', '2026-05-01T00:00:00Z'));
    expect(gitNewer).toEqual({ action: 'conflict', winner: 'git' });
    const dbNewer = decidePull({ gitHash: 'gNew', gitCommitTime: '2026-04-01T00:00:00Z' }, row('dbNew', 'base', '2026-05-01T00:00:00Z'));
    expect(dbNewer).toEqual({ action: 'conflict', winner: 'db' });
  });
  it('deleted in git, db clean → delete', () => {
    expect(decidePull({ gitHash: '', gitCommitTime: 't', gitDeleted: true }, row('base', 'base')).action).toBe('delete');
  });
  it('deleted in git, db dirty → conflict', () => {
    expect(decidePull({ gitHash: '', gitCommitTime: '2026-06-01T00:00:00Z', gitDeleted: true }, row('dbNew', 'base', '2026-05-01T00:00:00Z')).action).toBe('conflict');
  });
});

describe('decidePushFiles (§7.1 step 5)', () => {
  it('writes DB-dirty pages and removes synced tombstones', () => {
    const plan = decidePushFiles([
      { slug: 'clean', contentHash: 'h', gitSyncedHash: 'h', deletedAt: null }, // in sync → skip
      { slug: 'dirty', contentHash: 'h2', gitSyncedHash: 'h', deletedAt: null }, // changed → write
      { slug: 'new', contentHash: 'h3', gitSyncedHash: null, deletedAt: null }, // never synced → write
      { slug: 'gone', contentHash: 'h', gitSyncedHash: 'h', deletedAt: '2026-01-01', deleted: true } as any, // tombstone, was synced → delete
      { slug: 'gone-unsynced', contentHash: 'h', gitSyncedHash: null, deletedAt: '2026-01-01' }, // tombstone never synced → nothing
    ]);
    expect(plan.toWrite.sort()).toEqual(['dirty', 'new']);
    expect(plan.toDelete).toEqual(['gone']);
  });
});
