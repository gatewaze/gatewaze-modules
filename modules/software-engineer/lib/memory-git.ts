// @ts-nocheck
/**
 * Git-sync a project's memory wiki to its dedicated memory repo (`se_projects.memory_repo`, e.g.
 * `danthebaker/gatewaze-memory`). This is the "per-project git-sync repo" the memory module was
 * always designed for (see lib/memory.ts §22) but never wired up: memory only lived in the AI wiki
 * (Supabase), so the memory repos sat un-updated.
 *
 * Fires AFTER new information is committed to memory — approveMemory (reflect proposal promoted to
 * live) and approveSpec (a run's spec approved on PR merge). It writes every RECALLABLE wiki page
 * (live memory + approved specs; NEVER a pending/unapproved page) to `wiki/<slug>.md` plus a
 * regenerated `index.md`, then commits + pushes with the project's PAT.
 *
 * Best-effort by construction: a missing repo/token/ai-module just no-ops, and it NEVER blocks the
 * approval it follows (callers fire-and-forget). The token is scrubbed from any logged error.
 *
 * Why it matters: the memory becomes portable + versioned, and usable OUTSIDE the runner — a
 * developer working on gatewaze locally can clone the same repo, read it for context, and (Part B)
 * contribute learnings back. Local dev then shares the SE agent's accumulated memory.
 */
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { git, authedRemote, redactToken } from './git.js';
import { getProject, resolveCommitIdentity } from './credentials.js';
import { useCaseFor, isRecallable } from './memory.js';

const BASE = () => process.env.GATEWAZE_INTERNAL_API_URL || 'http://api:3002';
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
async function wiki(path: string) {
  const r = await fetch(`${BASE()}/api/modules/ai${path}`, {
    headers: { 'Content-Type': 'application/json', 'x-gatewaze-internal-key': KEY() },
  });
  if (!r.ok) throw new Error(`wiki ${path} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// A wiki slug → a safe relative path fragment under wiki/. Slugs may contain '/' (e.g.
// `specs/issue-5`) → nested dirs, but never '..', a leading '/', or anything outside the ref-safe
// charset, so the write can't escape the repo or be read as a git flag.
const safeSlug = (slug: string): string | null => {
  const s = String(slug ?? '');
  if (!s || s.includes('..') || s.startsWith('/') || s.startsWith('-') || !/^[A-Za-z0-9._/-]+$/.test(s)) return null;
  return s;
};

/**
 * Sync one project's live memory to its memory repo. Returns {ok,reason} — callers log at most.
 * Safe to call often; a no-op commit is skipped (nothing pushed when the repo already matches).
 */
export async function syncMemoryToRepo(sb: unknown, projectId: string, logger?: any): Promise<{ ok: boolean; reason?: string }> {
  if (!projectId) return { ok: false, reason: 'no project' };
  let project: any;
  try { project = await getProject(sb, projectId); } catch { return { ok: false, reason: 'project lookup failed' }; }
  const token = project?.githubToken;
  const repo = String(project?.memoryRepo ?? '').trim();
  if (!token) return { ok: false, reason: 'no token' };
  if (!repo) return { ok: false, reason: 'no memory_repo configured' };
  if (!REPO_RE.test(repo)) return { ok: false, reason: 'invalid memory_repo' };
  const [owner, name] = repo.split('/');
  const uc = useCaseFor(projectId);

  // Collect every recallable page (live memory + approved specs; pending is never exported).
  let pages: Array<{ slug: string; title?: string }> = [];
  try {
    const l = await wiki(`/internal/wiki/list?use_case=${encodeURIComponent(uc)}&limit=500`);
    pages = (l?.pages ?? []).filter((p: any) => isRecallable(p.slug));
  } catch {
    return { ok: false, reason: 'wiki unavailable' };
  }
  const files: Array<{ path: string; title: string; body: string }> = [];
  for (const p of pages) {
    const rel = safeSlug(p.slug);
    if (!rel) continue;
    try {
      const d = await wiki(`/internal/wiki/read?use_case=${encodeURIComponent(uc)}&slug=${encodeURIComponent(p.slug)}`);
      if (d?.found) files.push({ path: `wiki/${rel}.md`, title: String(p.title ?? p.slug), body: String(d.page?.body ?? '') });
    } catch { /* skip an unreadable page rather than fail the whole sync */ }
  }

  const dir = await mkdtemp(join(tmpdir(), 'se-mem-'));
  try {
    await git(['clone', '--depth', '1', authedRemote(owner, name, token), dir]);
    const id = await resolveCommitIdentity(sb, project, token);
    await git(['-C', dir, 'config', 'user.name', id?.name || 'Gatewaze SE']);
    await git(['-C', dir, 'config', 'user.email', id?.email || 'se@users.noreply.github.com']);
    // Rewrite the wiki/ tree wholesale so deleted pages disappear from the repo too. README at the
    // repo root is left untouched; index.md is regenerated.
    await git(['-C', dir, 'rm', '-r', '--ignore-unmatch', '--quiet', 'wiki']).catch(() => {});
    for (const f of files) {
      const abs = join(dir, f.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.body.endsWith('\n') ? f.body : `${f.body}\n`);
    }
    const index = [
      `# ${project.name || 'Project'} — engineering memory`,
      '',
      '_Git-synced from the AI wiki by the Software Engineer module. Do not hand-edit `wiki/` —',
      'it is overwritten on the next sync. Approved memory + specs only (never pending)._',
      '',
      ...files.map((f) => `- [${f.title}](${f.path})`),
    ].join('\n') + '\n';
    await writeFile(join(dir, 'index.md'), index);

    await git(['-C', dir, 'add', '-A']);
    const status = await git(['-C', dir, 'status', '--porcelain']);
    if (!String(status).trim()) return { ok: true, reason: 'up to date' };
    await git(['-C', dir, 'commit', '-m', `chore(memory): sync ${files.length} page(s) from the AI wiki`]);
    await git(['-C', dir, 'push', 'origin', 'HEAD']);
    logger?.info?.('se: memory synced to repo', { project: projectId, repo, pages: files.length });
    return { ok: true };
  } catch (e: any) {
    logger?.warn?.('se: memory git-sync failed', { project: projectId, repo, error: redactToken(String(e?.message ?? e), token) });
    return { ok: false, reason: 'git sync failed' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
