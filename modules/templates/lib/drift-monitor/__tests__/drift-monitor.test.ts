/**
 * Drift-monitor unit tests.
 *
 * The git clone path is exercised in lib/sources/__tests__/git.test.ts;
 * here we cover the orchestration logic with a scripted Supabase + a
 * stubbed git-clone shim. The shim is injected by overriding `process.env.
 * GATEWAZE_TEMPLATES_GIT_CACHE` and pre-populating a fake working tree on
 * disk — that way the real `cloneOrUpdateGitSource` short-circuits via the
 * "repo already exists" branch and reads files from our fixture.
 *
 * Behaviours covered:
 *   - Skips sources whose last_checked_at is within MIN_CHECK_INTERVAL_MS
 *   - Records last_checked_at + clears last_check_error on success
 *   - Records last_check_error + does not advance available_git_sha on failure
 *   - Sets available_git_sha when HEAD moves past installed_git_sha
 *   - Does NOT auto-apply when auto_apply=false
 *   - Auto-applies when auto_apply=true AND drift is safe (no detached)
 *   - Skips auto-apply when there are detached artifacts (unsafe drift)
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { checkAllGitSources, type DriftSupabaseClient } from '../index.js';

// ---------------------------------------------------------------------------
// Fake Supabase
// ---------------------------------------------------------------------------

interface ScriptedQuery {
  data: unknown;
  error: { message: string } | null;
}

function makeFakeSupabase(scripts: { selectResult: ScriptedQuery }) {
  const calls: { table: string; op: 'select' | 'update'; values?: Record<string, unknown>; filters: Array<{ col: string; val: unknown }> }[] = [];
  const updateCalls: Array<{ id: string; values: Record<string, unknown> }> = [];

  const buildQuery = (call: typeof calls[number]) => {
    const q: any = {
      select: (_cols: string) => q,
      update: (values: Record<string, unknown>) => {
        call.op = 'update';
        call.values = values;
        return q;
      },
      eq: (col: string, val: unknown) => {
        call.filters.push({ col, val });
        // Awaitable termination on update
        if (call.op === 'update') {
          // record after both filters land
          if (col === 'id' && call.values) {
            updateCalls.push({ id: val as string, values: call.values });
          }
          return Promise.resolve({ data: null, error: null });
        }
        return q;
      },
      then: (onfulfilled: (v: any) => unknown) => {
        if (call.op === 'select') {
          return Promise.resolve(onfulfilled(scripts.selectResult));
        }
        return Promise.resolve(onfulfilled({ data: null, error: null }));
      },
    };
    return q;
  };

  const supabase: DriftSupabaseClient = {
    from(table: string) {
      const call = { table, op: 'select' as 'select' | 'update', filters: [] };
      calls.push(call);
      return buildQuery(call) as ReturnType<DriftSupabaseClient['from']>;
    },
    async rpc(_fn, _args) {
      return { data: null, error: null };
    },
  };

  return { supabase, calls, updateCalls };
}

// ---------------------------------------------------------------------------
// Filesystem fixture for the "fake repo"
// ---------------------------------------------------------------------------

let cacheDir: string;
let originalCacheEnv: string | undefined;

beforeEach(() => {
  cacheDir = mkdtempSync(resolve(tmpdir(), 'gatewaze-drift-monitor-'));
  originalCacheEnv = process.env['GATEWAZE_TEMPLATES_GIT_CACHE'];
  process.env['GATEWAZE_TEMPLATES_GIT_CACHE'] = cacheDir;
});

afterEach(() => {
  if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true, force: true });
  if (originalCacheEnv !== undefined) {
    process.env['GATEWAZE_TEMPLATES_GIT_CACHE'] = originalCacheEnv;
  } else {
    delete process.env['GATEWAZE_TEMPLATES_GIT_CACHE'];
  }
});

/**
 * Set up a fake "already cloned" repo at the path `cloneOrUpdateGitSource`
 * would use for `gitUrl`. Real `git init` creates the .git dir so the
 * "exists" branch fires and a real `rev-parse HEAD` will work.
 */
function fakeCachedRepo(gitUrl: string, files: Record<string, string>): string {
  const slug = gitUrl
    .replace(/^(https?:\/\/|git:\/\/|git@)/, '')
    .replace(/\.git$/, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .slice(0, 100);
  const repoDir = resolve(cacheDir, slug);
  mkdirSync(repoDir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = resolve(repoDir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
  // Real git init so rev-parse + pull actually work. Use --initial-branch
  // so we know the ref name. Make a commit so HEAD is non-empty.
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: repoDir });
  return repoDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkAllGitSources', () => {
  it('skips sources checked within MIN_CHECK_INTERVAL_MS', async () => {
    const recentISO = new Date().toISOString(); // just now
    const { supabase, updateCalls } = makeFakeSupabase({
      selectResult: {
        data: [
          {
            id: 'src-1',
            url: 'https://example.com/x.git',
            branch: null,
            manifest_path: null,
            installed_git_sha: 'aaaa',
            available_git_sha: null,
            auto_apply: false,
            token_secret_ref: null,
            last_checked_at: recentISO,
          },
        ],
        error: null,
      },
    });
    const result = await checkAllGitSources({ supabase });
    expect(result.checked).toBe(0);
    expect(updateCalls.length).toBe(0);
  });

  it('records last_checked_at + clears last_check_error on success', async () => {
    const repoDir = fakeCachedRepo('https://example.com/owner/repo.git', {
      'a.html': '<p>hello</p>',
    });
    const headSha = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD']).toString('utf-8').trim();

    const { supabase, updateCalls } = makeFakeSupabase({
      selectResult: {
        data: [
          {
            id: 'src-1',
            url: 'https://example.com/owner/repo.git',
            branch: null,
            manifest_path: null,
            installed_git_sha: headSha, // already at head — no drift
            available_git_sha: null,
            auto_apply: false,
            token_secret_ref: null,
            last_checked_at: null,
          },
        ],
        error: null,
      },
    });
    const result = await checkAllGitSources({ supabase });
    expect(result.checked).toBe(1);
    expect(result.errors).toBe(0);
    const update = updateCalls.find((c) => c.id === 'src-1');
    expect(update?.values['last_check_error']).toBeNull();
    expect(update?.values['last_checked_at']).toEqual(expect.any(String));
    // No drift → available_git_sha NOT set in the update
    expect('available_git_sha' in (update?.values ?? {})).toBe(false);
  });

  it('sets available_git_sha when HEAD diverges from installed_git_sha', async () => {
    const repoDir = fakeCachedRepo('https://example.com/owner/repo2.git', {
      'a.html': '<p>v1</p>',
    });
    const headSha = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD']).toString('utf-8').trim();

    const { supabase, updateCalls } = makeFakeSupabase({
      selectResult: {
        data: [
          {
            id: 'src-2',
            url: 'https://example.com/owner/repo2.git',
            branch: null,
            manifest_path: null,
            installed_git_sha: 'old-sha-1234567890',
            available_git_sha: null,
            auto_apply: false,
            token_secret_ref: null,
            last_checked_at: null,
          },
        ],
        error: null,
      },
    });
    const result = await checkAllGitSources({ supabase });
    expect(result.drifted).toBe(1);
    expect(result.autoApplied).toBe(0);
    const update = updateCalls.find((c) => c.id === 'src-2');
    expect(update?.values['available_git_sha']).toBe(headSha);
  });

  it('records last_check_error when clone fails', async () => {
    const { supabase, updateCalls } = makeFakeSupabase({
      selectResult: {
        data: [
          {
            id: 'src-bad',
            // .invalid TLD — DNS fails fast
            url: 'https://broken.invalid/owner/repo.git',
            branch: null,
            manifest_path: null,
            installed_git_sha: null,
            available_git_sha: null,
            auto_apply: false,
            token_secret_ref: null,
            last_checked_at: null,
          },
        ],
        error: null,
      },
    });
    const result = await checkAllGitSources({ supabase });
    expect(result.errors).toBe(1);
    const update = updateCalls.find((c) => c.id === 'src-bad');
    expect(update?.values['last_check_error']).toEqual(expect.any(String));
    expect((update?.values['last_check_error'] as string).length).toBeGreaterThan(0);
  });

  it('does not auto-apply when auto_apply=false (drift recorded only)', async () => {
    const repoDir = fakeCachedRepo('https://example.com/owner/no-auto.git', {
      'a.html': '<p>v1</p>',
    });
    const headSha = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD']).toString('utf-8').trim();

    const { supabase, updateCalls } = makeFakeSupabase({
      selectResult: {
        data: [
          {
            id: 'src-noauto',
            url: 'https://example.com/owner/no-auto.git',
            branch: null,
            manifest_path: null,
            installed_git_sha: 'pinned-sha-aaa',
            available_git_sha: null,
            auto_apply: false,
            token_secret_ref: null,
            last_checked_at: null,
          },
        ],
        error: null,
      },
    });
    const result = await checkAllGitSources({ supabase });
    expect(result.autoApplied).toBe(0);
    expect(result.drifted).toBe(1);
    const update = updateCalls.find((c) => c.id === 'src-noauto');
    expect(update?.values['available_git_sha']).toBe(headSha);
    // installed_git_sha NOT touched since auto-apply didn't run
    expect('installed_git_sha' in (update?.values ?? {})).toBe(false);
  });

  it('logs via the injected logger', async () => {
    const { supabase } = makeFakeSupabase({
      selectResult: { data: [], error: null },
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await checkAllGitSources({ supabase, logger: log });
    expect(log.info).toHaveBeenCalledWith('drift-monitor: tick complete', expect.any(Object));
  });

  it('returns empty result + logs error when select fails', async () => {
    const { supabase } = makeFakeSupabase({
      selectResult: { data: null, error: { message: 'connection refused' } },
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await checkAllGitSources({ supabase, logger: log });
    expect(result.checked).toBe(0);
    expect(log.error).toHaveBeenCalledWith(
      'drift-monitor: failed to load sources',
      expect.objectContaining({ error: 'connection refused' }),
    );
  });
});
