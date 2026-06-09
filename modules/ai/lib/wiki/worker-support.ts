/**
 * Shared support for the wiki sync workers (ai:wiki-push / ai:wiki-pull).
 *
 * Builds WikiSyncDeps (service-role supabase + cost-tracked embed + git
 * token) and bootstraps a freshly-created empty remote so the first push
 * has a branch to clone. spec-ai-memory-wiki.md §5.3 / §7.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { runGit } from '../skills/git-client.js';
import type { WikiSyncDeps } from './sync.js';
import type { WikiDbClient, EmbedFn } from './repository.js';

/**
 * HTTPS git token for wiki push/pull. A dedicated WIKI_GIT_TOKEN wins;
 * otherwise reuse the worker's existing GITHUB_TOKEN. Null disables auth
 * (fine for public read, fails on push to a private/protected repo).
 */
export function resolveGitToken(): string | null {
  return process.env.WIKI_GIT_TOKEN || process.env.GITHUB_TOKEN || null;
}

/** Service-role supabase + a cost-tracked embedder, matching the API wiring. */
export function buildWikiSyncDeps(): WikiSyncDeps {
  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const embed: EmbedFn = async (texts: string[], useCase: string): Promise<number[][]> => {
    const { aiEmbed } = await import('../runner.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await aiEmbed({ supabase } as any, { useCase, userId: null, texts, systemRun: true });
    return r.vectors;
  };
  return { supabase: supabase as unknown as WikiDbClient, embed, gitToken: resolveGitToken() };
}

const AGENTS_TEMPLATE = (useCase: string): string =>
  `# AGENTS.md — wiki conventions for \`${useCase}\`

This repo is the durable knowledge wiki for the \`${useCase}\` AI use case.
It is maintained jointly by the model (via the wiki MCP tools) and humans
(via git / Obsidian). The DB is authoritative; this repo is a synced mirror.

## Layout
- \`wiki/\`  — LLM-authored synthesis pages (\`wiki/<slug>.md\`). Slugs are
  path-namespaced, e.g. \`wiki/sources/anthropic.md\`.
- \`raw/\`   — immutable source inputs (read-only to the model).
- \`index.md\` — generated catalog of live pages (do not hand-edit).

## Conventions
- Cross-link pages with \`[[path/slug]]\`.
- Keep one canonical page per entity; update it instead of forking.
- Put queryable fields (disposition, dates, scores) in YAML frontmatter.
- Edits here flow back to the DB on pull (last-writer-wins + conflict flag).
`;

const README_TEMPLATE = (useCase: string): string =>
  `# wiki: ${useCase}

Gatewaze AI memory wiki for the \`${useCase}\` use case. See AGENTS.md for
conventions. Pages live under \`wiki/\`; \`index.md\` is generated.
`;

/**
 * If the remote has no <branch> yet (a freshly-created empty repo), seed it
 * with an AGENTS.md schema layer + README and push, so runWikiPush's
 * `clone --branch` has a ref to check out. Idempotent: a no-op once the
 * branch exists. Returns true iff it bootstrapped.
 */
export async function ensureRemoteBranch(
  remote: string,
  branch: string,
  token: string | null,
  useCase: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  const ls = await runGit(['ls-remote', '--heads', remote, branch], { timeoutMs, authToken: token });
  if (ls.stdout.trim()) return false; // branch already exists — nothing to do

  const dir = mkdtempSync(join(tmpdir(), 'wiki-bootstrap-'));
  try {
    await runGit(['init'], { cwd: dir, timeoutMs });
    await runGit(['checkout', '-b', branch], { cwd: dir, timeoutMs });
    writeFileSync(join(dir, 'AGENTS.md'), AGENTS_TEMPLATE(useCase), 'utf8');
    writeFileSync(join(dir, 'README.md'), README_TEMPLATE(useCase), 'utf8');
    await runGit(['add', '-A'], { cwd: dir, timeoutMs });
    await runGit(
      ['-c', 'user.email=wiki@gatewaze.local', '-c', 'user.name=Gatewaze Wiki',
        'commit', '-m', 'chore: initialize wiki repo'],
      { cwd: dir, timeoutMs },
    );
    await runGit(['push', remote, `HEAD:${branch}`], { cwd: dir, timeoutMs, authToken: token });
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read the use case's sync target (remote + branch) from ai_wiki_sync_state. */
export async function loadSyncTarget(
  deps: WikiSyncDeps,
  useCase: string,
): Promise<{ git_remote: string | null; git_branch: string } | null> {
  const r = await deps.supabase
    .from('ai_wiki_sync_state')
    .select('git_remote, git_branch')
    .eq('use_case', useCase)
    .maybeSingle();
  return (r.data as { git_remote: string | null; git_branch: string } | null) ?? null;
}
