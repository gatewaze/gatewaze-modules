// @ts-nocheck — vitest types resolved at workspace install time
import { describe, expect, it, vi } from 'vitest';
import { preMergeCheck, type CommitInspection, type PageLockState } from '../pre-merge-hook.js';

const ARGS = { fromBranch: 'main', toBranch: 'publish' };

function makeDeps(inspections: CommitInspection[], locks: PageLockState[]) {
  return {
    inspectCommits: vi.fn(async () => inspections),
    fetchPageLocks: vi.fn(async () => locks),
  };
}

describe('preMergeCheck — pass-through cases', () => {
  it('returns ok when no commits', async () => {
    const r = await preMergeCheck(makeDeps([], []), ARGS);
    expect(r.ok).toBe(true);
  });

  it('returns ok when no content/pages files modified', async () => {
    const inspections: CommitInspection[] = [
      { commitSha: 'aaa', filePath: 'src/components/Header.tsx', workerAuthorTrailer: null },
      { commitSha: 'bbb', filePath: 'theme.json', workerAuthorTrailer: null },
    ];
    const r = await preMergeCheck(makeDeps(inspections, []), ARGS);
    expect(r.ok).toBe(true);
  });

  it('passes through when page is not wysiwyg_locked', async () => {
    const inspections: CommitInspection[] = [
      { commitSha: 'aaa', filePath: 'content/pages/about.json', workerAuthorTrailer: null },
    ];
    const r = await preMergeCheck(makeDeps(inspections, [{ slug: 'about', wysiwygLocked: false }]), ARGS);
    expect(r.ok).toBe(true);
  });

  it('passes through when worker trailer is present', async () => {
    const inspections: CommitInspection[] = [
      { commitSha: 'aaa', filePath: 'content/pages/home.json', workerAuthorTrailer: 'publish-worker-v1' },
    ];
    const r = await preMergeCheck(makeDeps(inspections, [{ slug: 'home', wysiwygLocked: true }]), ARGS);
    expect(r.ok).toBe(true);
  });
});

describe('preMergeCheck — rejection cases', () => {
  it('rejects when locked page modified by non-worker commit', async () => {
    const inspections: CommitInspection[] = [
      { commitSha: 'aaa', filePath: 'content/pages/home.json', workerAuthorTrailer: null },
    ];
    const r = await preMergeCheck(makeDeps(inspections, [{ slug: 'home', wysiwygLocked: true }]), ARGS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejection.code).toBe('apply.locked_content_modified');
      expect(r.rejection.details).toEqual([
        { file: 'content/pages/home.json', commitSha: 'aaa', slug: 'home', expectedAuthor: 'publish-worker' },
      ]);
    }
  });

  it('collects multiple rejections', async () => {
    const inspections: CommitInspection[] = [
      { commitSha: 'aaa', filePath: 'content/pages/home.json', workerAuthorTrailer: null },
      { commitSha: 'bbb', filePath: 'content/pages/about.json', workerAuthorTrailer: 'someone-else' },
      { commitSha: 'ccc', filePath: 'content/pages/contact.json', workerAuthorTrailer: 'publish-worker-v2' },
    ];
    const locks: PageLockState[] = [
      { slug: 'home', wysiwygLocked: true },
      { slug: 'about', wysiwygLocked: true },
      { slug: 'contact', wysiwygLocked: true },
    ];
    const r = await preMergeCheck(makeDeps(inspections, locks), ARGS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejection.details).toHaveLength(2);
      expect(r.rejection.details.map((d) => d.slug).sort()).toEqual(['about', 'home']);
    }
  });

  it('rejects nested page paths under content/pages/', async () => {
    const inspections: CommitInspection[] = [
      { commitSha: 'aaa', filePath: 'content/pages/blog/post-1.json', workerAuthorTrailer: null },
    ];
    const r = await preMergeCheck(makeDeps(inspections, [{ slug: 'blog/post-1', wysiwygLocked: true }]), ARGS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejection.details[0].slug).toBe('blog/post-1');
    }
  });
});

describe('preMergeCheck — bulk lookup behaviour', () => {
  it('passes a deduped slug list to fetchPageLocks', async () => {
    const inspections: CommitInspection[] = [
      { commitSha: 'aaa', filePath: 'content/pages/home.json', workerAuthorTrailer: null },
      { commitSha: 'bbb', filePath: 'content/pages/home.json', workerAuthorTrailer: null }, // dup
      { commitSha: 'ccc', filePath: 'content/pages/about.json', workerAuthorTrailer: null },
    ];
    const deps = makeDeps(inspections, []);
    await preMergeCheck(deps, ARGS);
    expect(deps.fetchPageLocks).toHaveBeenCalledWith(expect.arrayContaining(['home', 'about']));
    expect(deps.fetchPageLocks.mock.calls[0][0]).toHaveLength(2);
  });
});
