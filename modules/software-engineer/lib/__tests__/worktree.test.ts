// @ts-nocheck — vitest harness; the lib is @ts-nocheck'd already.
//
// Regression coverage for issue #56: when the implement/revise/code-refine agent runs `git commit`
// itself, the working tree goes clean again, so `hasChanges()` alone can't tell "nothing happened"
// apart from "the agent committed its own work". These tests exercise `commitsAhead` and
// `pushBranch` against a REAL git repo on disk (not a mocked `execFile`), since the whole point of
// the bug is a git-state interaction between `git status --porcelain` and `git rev-list`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hasChanges, commitsAhead, pushBranch } from '../worktree.js';

const pexec = promisify(execFile);
async function git(args: string[], cwd: string) {
  const { stdout } = await pexec('git', args, { cwd });
  return stdout;
}

async function initRepo(dir: string) {
  await git(['init', '-b', 'main'], dir);
  await git(['config', 'user.name', 'Test'], dir);
  await git(['config', 'user.email', 'test@example.com'], dir);
  await writeFile(join(dir, 'README.md'), 'hello\n', 'utf8');
  await git(['add', '-A'], dir);
  await git(['commit', '-m', 'initial'], dir);
}

describe('worktree commitsAhead / hasChanges / pushBranch', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'se-worktree-test-'));
    await initRepo(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports 0 commits ahead right after checkout, before any agent work', async () => {
    const startSha = (await git(['rev-parse', 'HEAD'], dir)).trim();
    expect(await commitsAhead(dir, startSha)).toBe(0);
    expect(await hasChanges(dir)).toBe(false);
  });

  it('the self-commit regression: clean tree but commits ahead after the agent commits its own work', async () => {
    const startSha = (await git(['rev-parse', 'HEAD'], dir)).trim();
    await writeFile(join(dir, 'feature.txt'), 'agent work\n', 'utf8');
    await git(['add', '-A'], dir);
    await git(['commit', '-m', 'agent self-commit'], dir);

    expect(await hasChanges(dir)).toBe(false);
    expect(await commitsAhead(dir, startSha)).toBe(1);
  });

  it('the pre-existing working case: dirty tree, no new commits', async () => {
    const startSha = (await git(['rev-parse', 'HEAD'], dir)).trim();
    await writeFile(join(dir, 'feature.txt'), 'agent work\n', 'utf8');

    expect(await hasChanges(dir)).toBe(true);
    expect(await commitsAhead(dir, startSha)).toBe(0);
  });

  it('both signals true at once: a commit plus a further uncommitted edit', async () => {
    const startSha = (await git(['rev-parse', 'HEAD'], dir)).trim();
    await writeFile(join(dir, 'feature.txt'), 'agent work\n', 'utf8');
    await git(['add', '-A'], dir);
    await git(['commit', '-m', 'agent self-commit'], dir);
    await writeFile(join(dir, 'feature.txt'), 'more agent work\n', 'utf8');

    expect(await hasChanges(dir)).toBe(true);
    expect(await commitsAhead(dir, startSha)).toBe(1);
  });

  it('pushBranch pushes the current branch to a remote without anything staged', async () => {
    const bareDir = await mkdtemp(join(tmpdir(), 'se-worktree-bare-'));
    try {
      await git(['init', '--bare', '-b', 'main', bareDir], bareDir);
      await git(['remote', 'add', 'origin', bareDir], dir);
      await git(['checkout', '-b', 'agent-branch'], dir);
      await writeFile(join(dir, 'feature.txt'), 'agent work\n', 'utf8');
      await git(['add', '-A'], dir);
      await git(['commit', '-m', 'agent self-commit'], dir);

      expect(await hasChanges(dir)).toBe(false);
      await pushBranch(dir, 'agent-branch');

      const remoteHead = (await git(['ls-remote', bareDir, 'refs/heads/agent-branch'], dir)).trim().split(/\s+/)[0];
      const localHead = (await git(['rev-parse', 'HEAD'], dir)).trim();
      expect(remoteHead).toBe(localHead);
    } finally {
      await rm(bareDir, { recursive: true, force: true });
    }
  });

  it('commitsAhead(dir, null) is 0 — the read-only-repo / no-start-point guard', async () => {
    expect(await commitsAhead(dir, null)).toBe(0);
  });
});
