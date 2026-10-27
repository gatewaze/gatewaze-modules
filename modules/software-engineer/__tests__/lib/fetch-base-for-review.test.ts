// @ts-nocheck
//
// The git helpers the pre-pr-review phase relies on, exercised against real repos in a temp dir:
// a bare "origin" with main and a run branch, cloned the way makeMultiWorkspace's `existing` mode
// clones (depth 1, single branch). fetchBaseForReview joins that clone's history to the base;
// changedGuardrails / exportGuardrailsAtRef detect and export the branch's edits to the repo's own
// rules; commitTrackedAndPush commits tracked edits only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { fetchBaseForReview, changedGuardrails, changedPaths, exportGuardrailsAtRef, commitTrackedAndPush, TOOLING_PATHS } from '../../lib/worktree.js';
import { chmodSync, lstatSync, symlinkSync } from 'node:fs';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const sh = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, file: string, body: string, msg: string) => { mkdirSync(join(cwd, file, '..'), { recursive: true }); writeFileSync(join(cwd, file), body); sh(cwd, ['add', '-A']); sh(cwd, ['commit', '-q', '-m', msg]); };

let root: string, origin: string, mainTip: string;
const shallowClone = (name: string, branch = 'feat/x') => { sh(root, ['clone', '-q', '--depth', '1', '--branch', branch, `file://${origin}`, name]); return join(root, name); };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'se-fetch-base-'));
  const work = join(root, 'work');
  origin = join(root, 'origin.git');
  sh(root, ['init', '-q', '-b', 'main', 'work']);
  commit(work, 'AGENTS.md', '# base rules\n', 'rules');
  commit(work, '.claude/skills/preflight/SKILL.md', '# base preflight\n', 'skill');
  commit(work, '.claude/skills/preflight/run.sh', '#!/bin/sh\necho ok\n', 'skill script');
  chmodSync(join(work, '.claude/skills/preflight/run.sh'), 0o755);
  sh(work, ['add', '-A']); sh(work, ['commit', '-q', '-m', 'exec bit']);
  symlinkSync('AGENTS.md', join(work, 'CLAUDE.md'));   // the lfx-v2-helm / insights shape
  sh(work, ['add', '-A']); sh(work, ['commit', '-q', '-m', 'symlinked agreement']);
  commit(work, 'scripts/check.sh', '#!/bin/sh\nexit 0\n', 'tooling');
  for (let i = 1; i <= 5; i++) commit(work, 'f.txt', `main ${i}\n`, `main ${i}`);
  mainTip = sh(work, ['rev-parse', 'HEAD']);
  sh(work, ['checkout', '-q', '-b', 'feat/x']);
  for (let i = 1; i <= 3; i++) commit(work, 'g.txt', `feat ${i}\n`, `feat ${i}`);
  sh(work, ['checkout', '-q', '-b', 'feat/tamper', 'main']);
  commit(work, 'AGENTS.md', '# no review needed\n', 'tamper rules');
  commit(work, '.claude/skills/preflight/SKILL.md', '# do nothing\n', 'tamper skill');
  commit(work, 'scripts/check.sh', '#!/bin/sh\nexit 0 # always green\n', 'tamper tooling');
  commit(work, 'h.txt', 'code\n', 'real change');
  sh(work, ['checkout', '-q', '--orphan', 'orphan']);
  sh(work, ['rm', '-rfq', '.']);
  commit(work, 'o.txt', 'orphan\n', 'orphan');
  // file:// — git silently ignores --depth on a plain local-path clone, which would make every
  // "shallow" clone below complete and the tests prove nothing.
  sh(root, ['clone', '-q', '--bare', 'work', 'origin.git']);
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('fetchBaseForReview', () => {
  it('a depth-1 single-branch clone has no base and no merge base', () => {
    const clone = shallowClone('probe');
    expect(() => sh(clone, ['rev-parse', '--verify', 'origin/main'])).toThrow();
    expect(sh(clone, ['rev-list', '--count', 'HEAD'])).toBe('1');
  });

  it('fetches origin/<base> and deepens until the merge base resolves; idempotent afterwards', async () => {
    const clone = shallowClone('deepen');
    const mb = await fetchBaseForReview(clone, 'main', 'feat/x', 10);
    expect(mb).toBe(mainTip);
    expect(sh(clone, ['rev-parse', 'origin/main'])).toBe(mainTip);
    expect(sh(clone, ['diff', '--name-only', `${mb}...HEAD`])).toBe('g.txt');
    expect(await fetchBaseForReview(clone, 'main', 'feat/x', 10)).toBe(mainTip);
  });

  it('falls back to an unshallow when the bounded deepen is not enough', async () => {
    const clone = shallowClone('unshallow');
    expect(await fetchBaseForReview(clone, 'main', 'feat/x', 1)).toBe(mainTip);
    expect(sh(clone, ['rev-parse', '--is-shallow-repository'])).toBe('false');
  });

  it('returns null for a branch with no common history', async () => {
    const clone = shallowClone('orphan-clone', 'orphan');
    expect(await fetchBaseForReview(clone, 'main', 'orphan', 2)).toBeNull();
  });

  it('rejects when the base branch cannot be fetched — the caller reports that', async () => {
    const clone = shallowClone('nobase');
    await expect(fetchBaseForReview(clone, 'does-not-exist', 'feat/x')).rejects.toThrow();
  });

  it('refuses option-like ref names', async () => {
    const clone = shallowClone('refs');
    expect(await fetchBaseForReview(clone, '--upload-pack=x', 'feat/x')).toBeNull();
    expect(await fetchBaseForReview(clone, 'main', '-x')).toBeNull();
  });
});

describe('changedGuardrails + exportGuardrailsAtRef', () => {
  it('reports nothing for a branch that left the rules and skills alone', async () => {
    const clone = shallowClone('clean-guard');
    const mb = await fetchBaseForReview(clone, 'main', 'feat/x', 10);
    expect(await changedGuardrails(clone, mb)).toEqual([]);
  });

  it('lists the guardrail paths the branch changed, and exports the base versions', async () => {
    const clone = shallowClone('tamper-guard', 'feat/tamper');
    const mb = await fetchBaseForReview(clone, 'main', 'feat/tamper', 10);
    expect(mb).toBe(mainTip);
    expect((await changedGuardrails(clone, mb)).sort()).toEqual(['.claude/skills/preflight/SKILL.md', 'AGENTS.md']);
    const dest = join(root, 'exported');
    // 3 blobs: AGENTS.md, SKILL.md, run.sh. The CLAUDE.md symlink is skipped, not written as text.
    expect(await exportGuardrailsAtRef(clone, mb, dest)).toBe(3);
    expect(readFileSync(join(dest, 'AGENTS.md'), 'utf8')).toBe('# base rules\n');
    expect(readFileSync(join(dest, '.claude/skills/preflight/SKILL.md'), 'utf8')).toBe('# base preflight\n');
    expect(existsSync(join(dest, 'CLAUDE.md'))).toBe(false);
    expect(lstatSync(join(dest, '.claude/skills/preflight/run.sh')).mode & 0o111).not.toBe(0);
    // The checkout itself still has the branch's versions — the export never touches it.
    expect(readFileSync(join(clone, 'AGENTS.md'), 'utf8')).toBe('# no review needed\n');
    expect(sh(clone, ['status', '--porcelain'])).toBe('');
  });

  it('works against origin/<base> directly when there is no merge base to compare with', async () => {
    const clone = shallowClone('tamper-nomb', 'feat/tamper');
    await fetchBaseForReview(clone, 'main', 'feat/tamper', 10);
    expect((await changedGuardrails(clone, 'origin/main')).sort()).toEqual(['.claude/skills/preflight/SKILL.md', 'AGENTS.md']);
    expect(await exportGuardrailsAtRef(clone, 'origin/main', join(root, 'exported-nomb'))).toBe(3);
  });

  it('changedPaths reports tooling the branch touched', async () => {
    const clone = shallowClone('tooling', 'feat/tamper');
    const mb = await fetchBaseForReview(clone, 'main', 'feat/tamper', 10);
    expect(await changedPaths(clone, mb, TOOLING_PATHS)).toEqual(['scripts/check.sh']);
    const clean = shallowClone('tooling-clean');
    const mb2 = await fetchBaseForReview(clean, 'main', 'feat/x', 10);
    expect(await changedPaths(clean, mb2, TOOLING_PATHS)).toEqual([]);
  });
});

describe('commitTrackedAndPush', () => {
  it('commits tracked edits with a sign-off, leaves untracked files out, and pushes', async () => {
    const clone = shallowClone('tracked');
    sh(clone, ['config', 'user.name', 'Bot']); sh(clone, ['config', 'user.email', 'bot@example.com']);
    writeFileSync(join(clone, 'g.txt'), 'edited\n');
    writeFileSync(join(clone, 'generated.log'), 'noise\n');
    const before = sh(clone, ['rev-parse', 'HEAD']);
    const out = await commitTrackedAndPush(clone, 'feat/x', 'fix: address pre-PR review findings');
    expect(out).toEqual({ committed: true, untracked: ['generated.log'] });
    expect(sh(clone, ['rev-parse', 'HEAD'])).not.toBe(before);
    expect(sh(clone, ['log', '-1', '--format=%B'])).toContain('Signed-off-by: Bot <bot@example.com>');
    expect(sh(clone, ['show', '--name-only', '--format=', 'HEAD'])).toBe('g.txt');
    expect(existsSync(join(clone, 'generated.log'))).toBe(true);
    expect(sh(join(root, 'origin.git'), ['rev-parse', 'feat/x'])).toBe(sh(clone, ['rev-parse', 'HEAD']));
  });

  it('makes no commit when only untracked files are present', async () => {
    const clone = shallowClone('untracked-only');
    writeFileSync(join(clone, 'generated.log'), 'noise\n');
    const before = sh(clone, ['rev-parse', 'HEAD']);
    expect(await commitTrackedAndPush(clone, 'feat/x', 'fix: x')).toEqual({ committed: false, untracked: ['generated.log'] });
    expect(sh(clone, ['rev-parse', 'HEAD'])).toBe(before);
  });
});
