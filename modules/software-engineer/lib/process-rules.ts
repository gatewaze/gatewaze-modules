// @ts-nocheck
/**
 * Per-project development-process rules (§7.6). A project can point at a file OR directory in a
 * roadmap repo (`process_repo` + `process_path`) holding its authoritative dev-process rules —
 * coding conventions, PR/commit rules, and (for LFX) the "architecture changes go via review first"
 * policy that drives the architecture-review gate. This module reads those rules at the start of
 * every agent phase (via the GitHub contents API — no clone) so phase-runner can inject them into the
 * system prompt above the generic flow.
 *
 * Trust: process_repo is an ADMIN-only project setting (same tier as the PAT), read with the project
 * token; the repo/path/ref are validated and NEVER sourced from issue/PR/user input. Best-effort:
 * returns '' when unconfigured or unreadable — a missing rules file never blocks a run.
 */
import { githubClient } from './github.js';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PATH_RE = /^[A-Za-z0-9_./-]+$/;
const REF_RE = /^[A-Za-z0-9_./-]+$/;
const MAX_TOTAL = 24_000;   // cap injected rules so they can't crowd out the task/context
const MAX_FILES = 20;

const b64 = (s) => { try { return Buffer.from(String(s ?? ''), 'base64').toString('utf8'); } catch { return ''; } };
const okPath = (p) => !!p && PATH_RE.test(p) && !p.split('/').includes('..');
const okRef = (r) => !!r && REF_RE.test(r) && !r.includes('..') && !r.startsWith('-');

/**
 * Read the project's process rules as markdown. If process_path is a directory, concatenates its
 * top-level .md files (sorted, capped). Returns '' when not configured or on any failure. Never throws.
 */
export async function fetchProcessRules(project: any, token: string, logger?: any): Promise<string> {
  const repo = String(project?.processRepo ?? '').trim();
  if (!repo || !REPO_RE.test(repo) || repo.includes('..') || !token) return '';
  const rawPath = String(project?.processPath ?? '').trim().replace(/^\/+|\/+$/g, '') || 'PROCESS.md';
  const path = okPath(rawPath) ? rawPath : 'PROCESS.md';
  const rawRef = String(project?.processRef ?? '').trim();
  const ref = okRef(rawRef) ? rawRef : undefined;
  const [owner, name] = repo.split('/');
  const gh = githubClient(token);
  try {
    const entry = await gh.getContent(owner, name, path, ref);
    if (Array.isArray(entry)) {
      // Directory: gather top-level .md files, in a stable order.
      const files = entry
        .filter((e) => e?.type === 'file' && String(e?.name ?? '').toLowerCase().endsWith('.md'))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .slice(0, MAX_FILES);
      const parts: string[] = [];
      let total = 0;
      for (const f of files) {
        if (total >= MAX_TOTAL) break;
        try {
          const c = await gh.getContent(owner, name, f.path, ref);
          const body = c?.content ? b64(c.content) : '';
          if (body.trim()) { const chunk = `## ${f.name}\n${body}`; parts.push(chunk); total += chunk.length; }
        } catch { /* skip an unreadable file */ }
      }
      return parts.join('\n\n').slice(0, MAX_TOTAL);
    }
    if (entry?.content) return b64(entry.content).slice(0, MAX_TOTAL);
    return '';
  } catch (e: any) {
    logger?.warn?.('se: process rules fetch failed', { repo, path, error: String(e?.message ?? e) });
    return '';
  }
}
