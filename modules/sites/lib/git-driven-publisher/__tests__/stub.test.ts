import { describe, expect, it, beforeEach } from 'vitest';
import { createStubGitDrivenPublisher } from '../stub.js';

describe('StubGitDrivenPublisher', () => {
  const pub = createStubGitDrivenPublisher();
  beforeEach(() => pub.reset());

  describe('commit', () => {
    it('accepts the first commit on a branch with baseCommitSha=null', async () => {
      const result = await pub.commit({
        secrets: {},
        repoRef: { remote: 'stub://test', branch: 'main' },
        baseCommitSha: null,
        files: [{ path: 'content/page.json', content: '{"title":"hi"}', encoding: 'utf-8' }],
        message: 'initial',
        author: { name: 'Test', email: 'test@example.com' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.commitSha).toMatch(/^[a-f0-9]{40}$/);
      }
      expect(pub.getBranches()).toEqual(['main']);
    });

    it('returns stale_base when baseCommitSha mismatches HEAD', async () => {
      await pub.commit({
        secrets: {},
        repoRef: { remote: 'stub://test', branch: 'main' },
        baseCommitSha: null,
        files: [{ path: 'a.txt', content: '1', encoding: 'utf-8' }],
        message: 'first',
        author: { name: 'T', email: 't@x' },
      });

      const result = await pub.commit({
        secrets: {},
        repoRef: { remote: 'stub://test', branch: 'main' },
        baseCommitSha: 'wrong-sha',
        files: [{ path: 'b.txt', content: '2', encoding: 'utf-8' }],
        message: 'should fail',
        author: { name: 'T', email: 't@x' },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('stale_base');
    });

    it('chains commits when baseCommitSha matches HEAD', async () => {
      const first = await pub.commit({
        secrets: {},
        repoRef: { remote: 'stub://test', branch: 'main' },
        baseCommitSha: null,
        files: [{ path: 'a.txt', content: '1', encoding: 'utf-8' }],
        message: 'first',
        author: { name: 'T', email: 't@x' },
      });
      if (!first.ok) throw new Error('first commit must succeed');

      const second = await pub.commit({
        secrets: {},
        repoRef: { remote: 'stub://test', branch: 'main' },
        baseCommitSha: first.commitSha,
        files: [{ path: 'b.txt', content: '2', encoding: 'utf-8' }],
        message: 'second',
        author: { name: 'T', email: 't@x' },
      });
      expect(second.ok).toBe(true);
      expect(pub.getCommits('main').length).toBe(2);
      // Files carry forward (incremental commit)
      const tree = pub.getFiles('main');
      expect(tree.get('a.txt')).toBe('1');
      expect(tree.get('b.txt')).toBe('2');
    });

    it('produces deterministic SHAs for the same input', async () => {
      const r1 = await pub.commit({
        secrets: {},
        repoRef: { remote: 'stub://a', branch: 'main' },
        baseCommitSha: null,
        files: [{ path: 'x', content: 'y', encoding: 'utf-8' }],
        message: 'm',
        author: { name: 'a', email: 'a@a' },
      });
      pub.reset();
      const r2 = await pub.commit({
        secrets: {},
        repoRef: { remote: 'stub://b', branch: 'main' },
        baseCommitSha: null,
        files: [{ path: 'x', content: 'y', encoding: 'utf-8' }],
        message: 'm',
        author: { name: 'a', email: 'a@a' },
      });
      if (!r1.ok || !r2.ok) throw new Error('both should succeed');
      expect(r1.commitSha).toBe(r2.commitSha);
    });
  });

  describe('verifyWebhookSignature', () => {
    it('round-trips an event signed by emitWebhook', async () => {
      const { rawBody, signature } = pub.emitWebhook({
        kind: 'build_succeeded',
        commitSha: 'abc123',
        deploymentId: 'dep-1',
        url: 'https://preview.example.com',
        durationMs: 12345,
      });
      const result = await pub.verifyWebhookSignature({
        secrets: {},
        headers: { 'x-stub-signature': signature },
        rawBody,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.event.kind).toBe('build_succeeded');
        if (result.event.kind === 'build_succeeded') {
          expect(result.event.commitSha).toBe('abc123');
          expect(result.event.url).toBe('https://preview.example.com');
        }
      }
    });

    it('rejects missing signature', async () => {
      const { rawBody } = pub.emitWebhook({ kind: 'build_started', commitSha: 'a', deploymentId: 'd' });
      const result = await pub.verifyWebhookSignature({ secrets: {}, headers: {}, rawBody });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('missing_signature');
    });

    it('rejects tampered signature', async () => {
      const { rawBody } = pub.emitWebhook({ kind: 'build_started', commitSha: 'a', deploymentId: 'd' });
      const result = await pub.verifyWebhookSignature({
        secrets: {},
        headers: { 'x-stub-signature': 'deadbeef' },
        rawBody,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('bad_signature');
    });

    it('rejects tampered body', async () => {
      const { signature } = pub.emitWebhook({ kind: 'build_started', commitSha: 'a', deploymentId: 'd' });
      const tampered = Buffer.from(JSON.stringify({ kind: 'build_failed', commitSha: 'evil', deploymentId: 'd', reason: 'x' }));
      const result = await pub.verifyWebhookSignature({
        secrets: {},
        headers: { 'x-stub-signature': signature },
        rawBody: new Uint8Array(tampered),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('bad_signature');
    });
  });

  describe('isAncestor', () => {
    it('returns true for direct parent', async () => {
      const a = await pub.commit({ secrets: {}, repoRef: { remote: 's', branch: 'main' }, baseCommitSha: null, files: [{ path: '1', content: '1', encoding: 'utf-8' }], message: 'a', author: { name: 'x', email: 'x@x' } });
      if (!a.ok) throw new Error('a');
      const b = await pub.commit({ secrets: {}, repoRef: { remote: 's', branch: 'main' }, baseCommitSha: a.commitSha, files: [{ path: '2', content: '2', encoding: 'utf-8' }], message: 'b', author: { name: 'x', email: 'x@x' } });
      if (!b.ok) throw new Error('b');
      expect(await pub.isAncestor!({ secrets: {}, parent: a.commitSha, child: b.commitSha })).toBe(true);
    });

    it('returns false when no relation', async () => {
      const a = await pub.commit({ secrets: {}, repoRef: { remote: 's', branch: 'main' }, baseCommitSha: null, files: [{ path: '1', content: '1', encoding: 'utf-8' }], message: 'a', author: { name: 'x', email: 'x@x' } });
      if (!a.ok) throw new Error('a');
      expect(await pub.isAncestor!({ secrets: {}, parent: 'unrelated', child: a.commitSha })).toBe(false);
    });
  });

  describe('reset', () => {
    it('clears all state', async () => {
      await pub.commit({ secrets: {}, repoRef: { remote: 's', branch: 'main' }, baseCommitSha: null, files: [{ path: 'x', content: 'y', encoding: 'utf-8' }], message: 'm', author: { name: 'x', email: 'x@x' } });
      expect(pub.getBranches().length).toBe(1);
      pub.reset();
      expect(pub.getBranches().length).toBe(0);
    });
  });
});
