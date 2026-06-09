/**
 * Bidirectional git sync orchestration. spec §7.
 *
 * Wires the *verified* decision core (sync-reconcile) + frontmatter round-trip
 * over git-client + the repository. The push/pull body here is git/DB I/O that
 * needs a running worker + a test remote to verify end-to-end; the branching
 * logic it calls is unit-tested (wiki-sync.test.ts). The platform worker
 * registry invokes runWikiPush / runWikiPull for the ai:wiki-push /
 * ai:wiki-pull jobs enqueued by the API (§6).
 */

import { mkdirSync, existsSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { runGit } from '../skills/git-client.js';
import { contentHash } from './hash.js';
import { serializePage, parseFrontmatter, type PageFile } from './frontmatter.js';
import { decidePushFiles, decidePull, type PushPageState } from './sync-reconcile.js';
import type { WikiDbClient, EmbedFn } from './repository.js';
import { upsertPage, softDeletePage } from './repository.js';

export interface WikiSyncDeps {
  supabase: WikiDbClient;
  embed?: EmbedFn;
  gitToken?: string | null;
  workdirRoot?: string;
  timeoutMs?: number;
}

const GIT_TIMEOUT = 60_000;

interface SyncState {
  use_case: string; git_remote: string | null; git_branch: string;
  synced_seq: number; pending_seq: number; last_commit_sha: string | null;
  pull_enabled: boolean; last_pulled_sha: string | null;
}

function repoDir(deps: WikiSyncDeps, useCase: string): string {
  const root = deps.workdirRoot || process.env.WIKI_SYNC_WORKDIR || join(tmpdir(), 'gatewaze-wiki');
  return join(root, useCase.replace(/[^a-zA-Z0-9_-]/g, '_'));
}

async function loadState(deps: WikiSyncDeps, useCase: string): Promise<SyncState | null> {
  const r = await deps.supabase.from('ai_wiki_sync_state').select('*').eq('use_case', useCase).maybeSingle();
  return (r.data as SyncState) ?? null;
}

async function ensureCheckout(deps: WikiSyncDeps, state: SyncState): Promise<string> {
  const dir = repoDir(deps, state.use_case);
  const t = deps.timeoutMs ?? GIT_TIMEOUT;
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dirname(dir), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    await runGit(['clone', '--branch', state.git_branch, '--depth', '50', state.git_remote!, dir], { timeoutMs: t, authToken: deps.gitToken ?? null });
  } else {
    await runGit(['fetch', 'origin', state.git_branch], { cwd: dir, timeoutMs: t, authToken: deps.gitToken ?? null });
    await runGit(['reset', '--hard', `origin/${state.git_branch}`], { cwd: dir, timeoutMs: t });
  }
  return dir;
}

function pageFilePath(dir: string, slug: string): string {
  return join(dir, 'wiki', `${slug}.md`);
}

/** Push DB → git (§7.1). Reconcile-then-write changed files, commit, push. */
export async function runWikiPush(deps: WikiSyncDeps, useCase: string): Promise<{ pushed: boolean; reason?: string }> {
  const state = await loadState(deps, useCase);
  if (!state || !state.git_remote) return { pushed: false, reason: 'no_remote' };
  if (state.pending_seq <= state.synced_seq) return { pushed: false, reason: 'nothing_pending' };

  const dir = await ensureCheckout(deps, state);
  const pagesRes = await deps.supabase
    .from('ai_wiki_page')
    .select('slug, title, body, summary, category, metadata, content_hash, git_synced_hash, deleted_at, updated_at')
    .eq('use_case', useCase);
  const pages = (pagesRes.data as Array<Record<string, unknown>>) ?? [];

  const plan = decidePushFiles(pages.map((p): PushPageState => ({
    slug: String(p.slug), contentHash: String(p.content_hash),
    gitSyncedHash: (p.git_synced_hash as string | null) ?? null, deletedAt: (p.deleted_at as string | null) ?? null,
  })));
  if (plan.toWrite.length === 0 && plan.toDelete.length === 0) return { pushed: false, reason: 'nothing_to_write' };

  const byslug = new Map(pages.map((p) => [String(p.slug), p]));
  for (const slug of plan.toWrite) {
    const p = byslug.get(slug)!;
    const file = pageFilePath(dir, slug);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serializePage({
      slug, title: String(p.title), summary: (p.summary as string) ?? null, category: (p.category as string) ?? null,
      updatedAt: (p.updated_at as string) ?? null, syncedHash: String(p.content_hash),
      metadata: (p.metadata as Record<string, unknown>) ?? {}, body: String(p.body ?? ''),
    }), 'utf8');
  }
  for (const slug of plan.toDelete) {
    await runGit(['rm', '-f', '--ignore-unmatch', join('wiki', `${slug}.md`)], { cwd: dir, timeoutMs: deps.timeoutMs ?? GIT_TIMEOUT });
  }
  writeFileSync(join(dir, 'index.md'), buildIndex(pages), 'utf8');

  await runGit(['add', '-A'], { cwd: dir, timeoutMs: deps.timeoutMs ?? GIT_TIMEOUT });
  const status = await runGit(['status', '--porcelain'], { cwd: dir, timeoutMs: deps.timeoutMs ?? GIT_TIMEOUT });
  if (!status.stdout.trim()) {
    await markSynced(deps, useCase, state.pending_seq, plan.toWrite, byslug);
    return { pushed: false, reason: 'no_diff' };
  }
  await runGit(['-c', 'user.email=wiki@gatewaze.local', '-c', 'user.name=Gatewaze Wiki', 'commit', '-m', `wiki: ${useCase} seq${state.pending_seq}`], { cwd: dir, timeoutMs: deps.timeoutMs ?? GIT_TIMEOUT });
  await runGit(['push', 'origin', `HEAD:${state.git_branch}`], { cwd: dir, timeoutMs: deps.timeoutMs ?? GIT_TIMEOUT, authToken: deps.gitToken ?? null });
  const head = (await runGit(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: deps.timeoutMs ?? GIT_TIMEOUT })).stdout.trim();

  await markSynced(deps, useCase, state.pending_seq, plan.toWrite, byslug, head);
  return { pushed: true };
}

async function markSynced(deps: WikiSyncDeps, useCase: string, pendingSeq: number, written: string[], byslug: Map<string, Record<string, unknown>>, head?: string): Promise<void> {
  for (const slug of written) {
    const p = byslug.get(slug)!;
    await deps.supabase.from('ai_wiki_page').update({ git_synced_hash: p.content_hash }).eq('use_case', useCase).eq('slug', slug);
  }
  await deps.supabase.from('ai_wiki_sync_state').update({
    synced_seq: pendingSeq, last_synced_at: new Date().toISOString(), last_error: null,
    ...(head ? { last_commit_sha: head } : {}),
  }).eq('use_case', useCase);
}

function buildIndex(pages: Array<Record<string, unknown>>): string {
  const live = pages.filter((p) => !p.deleted_at).sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  const lines = ['# Index', ''];
  for (const p of live) lines.push(`- [[${p.slug}]] — ${p.summary ?? p.title ?? ''}`);
  return lines.join('\n') + '\n';
}

/** Pull git → DB (§7.2). Diff since last_pulled_sha; reconcile last-writer-wins. */
export async function runWikiPull(deps: WikiSyncDeps, useCase: string): Promise<{ pulled: number; conflicts: number }> {
  const state = await loadState(deps, useCase);
  if (!state || !state.git_remote || !state.pull_enabled) return { pulled: 0, conflicts: 0 };

  const dir = await ensureCheckout(deps, state);
  const t = deps.timeoutMs ?? GIT_TIMEOUT;
  const head = (await runGit(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: t })).stdout.trim();
  const commitTime = (await runGit(['show', '-s', '--format=%cI', 'HEAD'], { cwd: dir, timeoutMs: t })).stdout.trim();

  const base = state.last_pulled_sha;
  const range = base ? `${base}..HEAD` : 'HEAD';
  const diff = base
    ? (await runGit(['diff', '--name-status', range, '--', 'wiki/'], { cwd: dir, timeoutMs: t })).stdout
    : (await runGit(['ls-files', 'wiki/'], { cwd: dir, timeoutMs: t })).stdout.split('\n').filter(Boolean).map((p) => `A\t${p}`).join('\n');

  let pulled = 0; let conflicts = 0;
  for (const line of diff.split('\n').filter(Boolean)) {
    const [status, path] = line.split('\t');
    if (!path || !path.startsWith('wiki/') || !path.endsWith('.md')) continue;
    const slug = path.slice('wiki/'.length, -'.md'.length);
    const deleted = status?.startsWith('D');
    const file = join(dir, path);
    let parsed: PageFile = { title: '', body: '', metadata: {}, summary: null, category: null };
    if (!deleted) {
      if (!existsSync(file)) continue;
      parsed = parseFrontmatter(readFileSync(file, 'utf8'));
    }
    const gitHash = deleted ? '' : contentHash(parsed.title, parsed.body);

    const rowRes = await deps.supabase.from('ai_wiki_page').select('content_hash, git_synced_hash, updated_at, title, body').eq('use_case', useCase).eq('slug', slug).maybeSingle();
    const row = rowRes.data as { content_hash: string; git_synced_hash: string | null; updated_at: string; title: string; body: string } | null;

    const decision = decidePull(
      { gitHash, gitCommitTime: commitTime, ...(deleted ? { gitDeleted: true } : {}) },
      row ? { contentHash: row.content_hash, gitSyncedHash: row.git_synced_hash, updatedAt: row.updated_at } : null,
    );

    if (decision.action === 'noop') {
      if (row && row.content_hash === gitHash) await deps.supabase.from('ai_wiki_page').update({ git_synced_hash: gitHash }).eq('use_case', useCase).eq('slug', slug);
      continue;
    }
    if (decision.action === 'db_wins_skip') continue;
    if (decision.action === 'delete') { await softDeletePage(deps.supabase, useCase, slug); pulled++; continue; }

    if (decision.action === 'create' || decision.action === 'accept_git' || (decision.action === 'conflict' && decision.winner === 'git')) {
      await upsertPage(deps.supabase, {
        useCase, slug, title: parsed.title, body: parsed.body, summary: parsed.summary, category: parsed.category,
        metadata: parsed.metadata, source: 'human',
      }, deps.embed ?? null);
      await deps.supabase.from('ai_wiki_page').update({ git_synced_hash: gitHash }).eq('use_case', useCase).eq('slug', slug);
      pulled++;
    }
    if (decision.action === 'conflict') {
      conflicts++;
      await deps.supabase.from('ai_wiki_page').update({
        conflict: true,
        conflict_detail: { winner: decision.winner, git_hash: gitHash, db_hash: row?.content_hash, git_commit: head, resolved_at: new Date().toISOString(), loser_title: decision.winner === 'git' ? row?.title : parsed.title, loser_body: decision.winner === 'git' ? row?.body : parsed.body },
      }).eq('use_case', useCase).eq('slug', slug);
    }
  }

  const cnt = await deps.supabase.from('ai_wiki_page').select('slug', { count: 'exact', head: true }).eq('use_case', useCase).eq('conflict', true);
  await deps.supabase.from('ai_wiki_sync_state').update({
    last_pulled_sha: head, last_synced_at: new Date().toISOString(),
    conflict_count: (cnt as { count?: number }).count ?? 0,
  }).eq('use_case', useCase);
  return { pulled, conflicts };
}
