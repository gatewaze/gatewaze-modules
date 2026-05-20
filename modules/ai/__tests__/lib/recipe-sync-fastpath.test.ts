/**
 * Regression test for the recipe-indexing bug fixed by migration 026.
 *
 * Bug: syncRecipeSource and syncSource (skills) shared the
 * `last_synced_commit` column on ai_agent_sources. The orchestrator
 * runs skills first; that pass updated last_synced_commit; the recipe
 * pass then read it back, compared against the same HEAD SHA, and
 * short-circuited with `recipesIndexed: 0`. Result: recipes were
 * effectively never indexed on the second-and-later sync.
 *
 * Fix: per-kind columns (last_synced_skills_commit /
 * last_synced_recipes_commit). The recipe fast-path now compares
 * against last_synced_recipes_commit only.
 *
 * What this test asserts:
 *   1. When last_synced_recipes_commit === HEAD → fast-path fires.
 *   2. When last_synced_recipes_commit !== HEAD BUT the shared
 *      last_synced_commit === HEAD → fast-path MUST NOT fire (this is
 *      the exact pre-fix scenario, induced when the orchestrator's
 *      skill pass ran first and updated last_synced_commit).
 *
 * The test stubs git + fs so we never touch the network or disk. We
 * route the post-fast-path walk into walkRoot-missing, which produces
 * a `walk_root_missing` warning — that warning's presence is the
 * positive signal that the function got past the fast-path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const HEAD_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// Mock the git plumbing so the function never shells out.
vi.mock('../../lib/skills/git-client.js', () => ({
  GitError: class GitError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  gitClone: vi.fn(async () => undefined),
  gitFetchHard: vi.fn(async () => undefined),
  gitRevParseHead: vi.fn(async () => HEAD_SHA),
}));

vi.mock('../../lib/skills/secret-shim.js', () => ({
  decryptSecret: vi.fn(() => null),
}));

// Pretend cacheDir exists (so we skip cloning) but walkRoot doesn't —
// that pushes the function into the walk_root_missing branch, which
// is the post-fast-path code path we want to detect.
//
// cacheDir resolves to /tmp/gatewaze-test/recipes/cache/<source-id>
// exactly; walkRoot resolves to <cacheDir>/<path_prefix> (e.g.
// /tmp/gatewaze-test/recipes/cache/source-2/recipes). Match the cache
// dir exactly so the walkRoot under it reports missing.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((p: string) =>
      /^\/tmp\/gatewaze-test\/recipes\/cache\/source-[^/]+$/.test(p),
    ),
    mkdirSync: vi.fn(() => undefined),
    readFileSync: actual.readFileSync,
    readdirSync: actual.readdirSync,
    realpathSync: actual.realpathSync,
    statSync: actual.statSync,
  };
});

// Point the cache root somewhere stable + invent a path_prefix that
// won't exist, so the walk-root-missing branch fires deterministically.
vi.mock('../../lib/recipes/recipes-config.js', () => ({
  recipesConfig: {
    skillsEnabled: true,
    recipeCacheRoot: '/tmp/gatewaze-test/recipes/cache',
    recipeSyncTimeoutMs: 30_000,
    maxRecipesPerSource: 50,
    recipeBodyMaxBytes: 64_000,
  },
}));

import { syncRecipeSource } from '../../lib/recipes/sync-source.js';

interface FakeSourceRow {
  id: string;
  git_url: string;
  branch: string;
  path_prefix: string;
  auth_token_ciphertext: string | null;
  last_synced_recipes_commit: string | null;
  last_synced_commit: string | null;
  sync_status: string;
  sync_lock_expires_at: string | null;
}

function makeSupabase(row: FakeSourceRow) {
  const updates: Array<Record<string, unknown>> = [];
  let lastTable = '';
  let lastUpdate: Record<string, unknown> | null = null;
  let lastSelectColumns = '';

  const builder = {
    update(values: Record<string, unknown>) {
      lastUpdate = values;
      return this;
    },
    delete() {
      return this;
    },
    upsert() {
      return this;
    },
    eq(_col: string, _val: string) {
      return this;
    },
    or(_expr: string) {
      return this;
    },
    not(_col: string, _op: string, _val: string) {
      return this;
    },
    select(columns: string) {
      lastSelectColumns = columns;
      return this;
    },
    async maybeSingle() {
      // The first call after .update().or().select() returns the
      // claim row. Subsequent .select().maybeSingle() calls (e.g.
      // upserts) don't matter for this test.
      if (lastTable === 'ai_agent_sources' && lastUpdate?.sync_status === 'syncing') {
        // Persist what columns the production code asked for so the
        // test can assert it queried the per-kind key.
        updates.push({ kind: 'claim', selectColumns: lastSelectColumns });
        return { data: row, error: null };
      }
      return { data: null, error: null };
    },
  };
  // releaseLock fires a fire-and-forget update without awaiting a
  // chain end — capture it via from().update().eq() returning undefined.
  return {
    from(table: string) {
      lastTable = table;
      return {
        ...builder,
        update: (values: Record<string, unknown>) => {
          // Lock-release update lands here; record it for assertions.
          if (
            table === 'ai_agent_sources' &&
            values.sync_status !== 'syncing'
          ) {
            updates.push({ kind: 'release', values });
          }
          lastUpdate = values;
          return builder;
        },
      };
    },
    _updates: updates,
  };
}

describe('syncRecipeSource HEAD-SHA fast-path (per-kind column)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fast-paths when last_synced_recipes_commit matches HEAD', async () => {
    const row: FakeSourceRow = {
      id: 'source-1',
      git_url: 'https://example.com/repo.git',
      branch: 'main',
      path_prefix: 'recipes',
      auth_token_ciphertext: null,
      last_synced_recipes_commit: HEAD_SHA,
      last_synced_commit: HEAD_SHA,
      sync_status: 'ok',
      sync_lock_expires_at: null,
    };
    const supabase = makeSupabase(row);

    const result = await syncRecipeSource({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      sourceId: 'source-1',
      trigger: 'manual',
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).not.toContain(
      expect.stringContaining('walk_root_missing'),
    );

    // The SELECT must include the per-kind column.
    const claim = supabase._updates.find((u) => u.kind === 'claim');
    expect(claim?.selectColumns).toContain('last_synced_recipes_commit');
    expect(claim?.selectColumns).not.toMatch(/(?<!recipes_)last_synced_commit/);
  });

  it('does NOT fast-path when last_synced_recipes_commit differs even if last_synced_commit matches HEAD', async () => {
    // This is the exact pre-fix scenario: the skill pass already
    // updated the shared last_synced_commit, but recipes have never
    // been indexed (last_synced_recipes_commit is stale / null).
    const row: FakeSourceRow = {
      id: 'source-2',
      git_url: 'https://example.com/repo.git',
      branch: 'main',
      path_prefix: 'recipes',
      auth_token_ciphertext: null,
      last_synced_recipes_commit: null,
      last_synced_commit: HEAD_SHA,
      sync_status: 'ok',
      sync_lock_expires_at: null,
    };
    const supabase = makeSupabase(row);

    const result = await syncRecipeSource({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      sourceId: 'source-2',
      trigger: 'manual',
    });

    // Walk root doesn't exist (path_prefix='recipes' under our fake
    // cache dir) so the function proceeds past the fast-path and
    // emits a walk_root_missing warning — proof it did NOT short-
    // circuit on the shared column.
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes('walk_root_missing'))).toBe(true);
  });
});
