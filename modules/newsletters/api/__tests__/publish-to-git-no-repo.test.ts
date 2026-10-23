import { describe, expect, it, vi } from 'vitest';
import { createPublishToGitRoute, type PublishToGitDeps } from '../publish-to-git';

/**
 * Publish on a newsletter with no external git repo: the edition is still
 * marked published (portal visibility), and git is never touched.
 */

function fakeSupabase(edition: { status: string }, collection: { git_provenance: string; git_url: string | null }) {
  const updates: Array<Record<string, unknown>> = [];
  const from = vi.fn((table: string) => {
    if (table === 'newsletters_editions') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'ed1', title: 't', edition_date: '2026-10-17', preheader: null, collection_id: 'c1', ...edition }, error: null }) }) }),
        update: (row: Record<string, unknown>) => { updates.push(row); return { eq: async () => ({ error: null }) }; },
      };
    }
    if (table === 'newsletters_template_collections') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'c1', slug: 's', name: 'n', git_url_theme: null, git_branch: 'publish', config: {}, view_online_external_base_url: null, ...collection }, error: null }) }) }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
  return { client: { from } as unknown as PublishToGitDeps['supabase'], updates };
}

function run(deps: PublishToGitDeps) {
  const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  const req = { userId: 'u1', params: { editionId: 'ed1' }, body: { html: '<p>x</p>', blockRender: [] } };
  return createPublishToGitRoute(deps)(req as never, res as never, (() => {}) as never).then(() => res);
}

describe('publish-to-git without an external repo', () => {
  const gitServer = { lookupRepo: vi.fn(), commit: vi.fn() } as unknown as NonNullable<PublishToGitDeps['gitServer']>;

  it('marks a draft published and reports git: false', async () => {
    const sb = fakeSupabase({ status: 'draft' }, { git_provenance: 'internal', git_url: null });
    const res = await run({ supabase: sb.client, gitServer });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ kind: 'published', git: false });
    expect(sb.updates).toEqual([expect.objectContaining({ status: 'published' })]);
    expect(gitServer.lookupRepo).not.toHaveBeenCalled();
  });

  it('does not change the status of an edition that is not a draft', async () => {
    const sb = fakeSupabase({ status: 'sent' }, { git_provenance: 'internal', git_url: null });
    const res = await run({ supabase: sb.client, gitServer });
    expect(res.body).toMatchObject({ kind: 'published', git: false });
    expect(sb.updates).toEqual([]);
  });

  it('treats external provenance without a URL as no repo', async () => {
    const sb = fakeSupabase({ status: 'draft' }, { git_provenance: 'external', git_url: null });
    const res = await run({ supabase: sb.client, gitServer });
    expect(res.body).toMatchObject({ kind: 'published', git: false });
    expect(gitServer.lookupRepo).not.toHaveBeenCalled();
  });
});
