// @ts-nocheck
/**
 * Per-project skills gate (§7.5a). By default the runner starts agent sessions with NO skills or
 * plugins — `settingSources: []` (agent-session.ts) deliberately skips the repo's .claude/settings.json
 * because it points at a plugin MARKETPLACE that can't fetch inside the runner container and aborts the
 * session. That left the SE agent unable to use any of the team's skills.
 *
 * This module restores skills the safe way: it clones each skills repo a project OPTS INTO
 * (`se_projects.skills`, an admin-only setting) and hands the SDK a LOCAL plugin config
 * (`{ type: 'local', path, skipMcpDiscovery: true }`) — no marketplace, no network fetch at session
 * start, and no plugin-declared MCP servers (the runner owns MCP; §10).
 *
 * Trust: skills come from ADMIN-only project config (same tier as the PAT), and a plugin can ship
 * hooks/agents that run inside a Bash-capable session — so the repo/path/ref are strictly validated,
 * NEVER sourced from issue/PR/user input. A repo that fails to clone is skipped (logged, token
 * scrubbed), never blocking the phase.
 *
 * Isolation: the clone goes into a FRESH per-run mkdtemp dir (never a shared/persistent path), and the
 * caller MUST call the returned `cleanup()` in its finally. This matters because the SE runner is
 * scoped per-MODULE, not per-project (the #68 SE-runner split) — multiple tenants' sessions run as
 * root on the SAME container filesystem, so a persistent cache under a predictable path would be
 * readable (and plantable) across tenants from inside a Bash-capable session. Ephemeral-per-run
 * removes that surface entirely and leaves no credentialed clone behind. The resolved plugin path is
 * also realpath-contained inside its clone, so a malicious skills repo can't symlink out to load host
 * files (or another clone) as a trusted plugin.
 */
import { cp, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { git, authedRemote, redactToken } from './git.js';

// owner/name — same shape as memory_repo. No '..', no leading '-'.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// A plugin sub-path within the repo (e.g. "plugins/gatewaze-skills"). Ref-safe charset only.
const PATH_RE = /^[A-Za-z0-9_./-]+$/;
const REF_RE = /^[A-Za-z0-9_./-]+$/;

const safeSlug = (s: string): string => String(s ?? '').replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 100);
// Strip leading/trailing '/' with a linear scan (no `\/+$`-style regex, which is polynomial-ReDoS-prone
// on a string of many slashes). 47 = '/'.
const stripSlashes = (s: string): string => {
  let i = 0, j = s.length;
  while (i < j && s.charCodeAt(i) === 47) i++;
  while (j > i && s.charCodeAt(j - 1) === 47) j--;
  return s.slice(i, j);
};

/**
 * Validate + normalise a project's `skills` config into clean {repo, path, ref} entries. Anything
 * malformed or unsafe (bad repo shape, path traversal, flag-like ref) is dropped, not repaired.
 * Exported for the admin-routes PUT allowlist to reuse the exact same guard.
 */
export function parseSkillsConfig(raw: unknown): Array<{ repo: string; path: string; ref: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ repo: string; path: string; ref: string }> = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const repo = String((e as any).repo ?? '').trim();
    const path = stripSlashes(String((e as any).path ?? '').trim());
    const ref = (String((e as any).ref ?? '').trim() || 'main');
    if (!REPO_RE.test(repo) || repo.includes('..')) continue;
    if (path && (!PATH_RE.test(path) || path.split('/').includes('..'))) continue;
    if (!REF_RE.test(ref) || ref.includes('..') || ref.startsWith('-')) continue;
    out.push({ repo, path, ref });
  }
  return out.slice(0, 10);
}

export type ResolvedSkills = {
  plugins: Array<{ type: 'local'; path: string; skipMcpDiscovery: true }>;
  /** Remove the ephemeral clone dir. Callers MUST await this in their finally. */
  cleanup: () => Promise<void>;
};

/**
 * Shallow-clone each configured skills repo into a FRESH per-run temp dir and return SDK local-plugin
 * configs pointing at the plugin dir inside each, plus a `cleanup()` that removes the whole temp tree.
 * Best-effort: returns empty plugins (and a no-op cleanup) when nothing is configured or the token is
 * missing; skips any repo that fails to clone or whose plugin path escapes its clone. Never throws.
 */
export async function resolveProjectSkills(project: any, token: string, logger?: any): Promise<ResolvedSkills> {
  const entries = parseSkillsConfig(project?.skills);
  if (entries.length === 0 || !token) return { plugins: [], cleanup: async () => {} };
  // Fresh, unpredictable dir per call — never a shared/persistent path (see the isolation note above).
  const root = await mkdtemp(join(tmpdir(), 'se-skills-'));
  const cleanup = async () => { await rm(root, { recursive: true, force: true }).catch(() => {}); };
  const plugins: ResolvedSkills['plugins'] = [];
  const cloned = new Map<string, string>(); // repo#ref → dir (clone each distinct repo+ref once)
  try {
    for (const e of entries) {
      const key = `${e.repo}#${e.ref}`;
      let dir = cloned.get(key);
      if (!dir) {
        dir = join(root, `${safeSlug(e.repo)}--${safeSlug(e.ref)}`);
        const [owner, name] = e.repo.split('/');
        try {
          // '--' ends option parsing; ref/repo are validated, but keep the belt. Shallow, single branch.
          await git(['clone', '--depth', '1', '--branch', e.ref, '--', authedRemote(owner, name, token), dir]);
          cloned.set(key, dir);
        } catch (err: any) {
          logger?.warn?.('se: skills clone failed', { repo: e.repo, ref: e.ref, error: redactToken(String(err?.message ?? err), token) });
          continue;
        }
      }
      // Resolve the plugin path and REJECT any symlink that escapes the clone — a malicious skills
      // repo must not be able to load host files (or a sibling clone) into the session as a plugin.
      const pluginPath = e.path ? join(dir, e.path) : dir;
      try {
        const [rp, rdir] = await Promise.all([realpath(pluginPath), realpath(dir)]);
        if (rp !== rdir && !rp.startsWith(rdir + sep)) {
          logger?.warn?.('se: skills plugin path escapes its clone — skipped', { repo: e.repo, path: e.path });
          continue;
        }
        plugins.push({ type: 'local', path: rp, skipMcpDiscovery: true });
      } catch {
        logger?.warn?.('se: skills plugin path missing', { repo: e.repo, path: e.path });
      }
    }
  } catch (err: any) {
    // Any unexpected failure: don't leak the temp dir.
    logger?.warn?.('se: skills resolve failed', { error: redactToken(String(err?.message ?? err), token) });
    await cleanup();
    return { plugins: [], cleanup: async () => {} };
  }
  return { plugins, cleanup };
}

/** The plugin name a repo's own skills load under: `<repo>-local`, in the plugin-name charset. */
export const repoLocalPluginName = (repoName: string): string => `${String(repoName ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80)}-local`;

/**
 * Repo-local skills: a code repo's own `.claude/skills/` directory. Sessions start with
 * `settingSources: []` (agent-session.ts), so the skills a repo's working agreement names — its
 * pre-PR readiness, preflight and knowledge-base review skills — never load on their own. This
 * materialises each workspace repo's `.claude/skills/` as a LOCAL plugin named `<repo>-local`: a
 * manifest plus a copy of the skills directory and nothing else, so the Skill tool lists them as
 * `/<repo>-local:<skill>`. No hooks, agents or MCP servers from the repo are loaded this way.
 *
 * Trust: the skills come from the repo the agent is already editing and running checks in with Bash,
 * so they add no capability the session does not already have. Symlinks inside the skills directory
 * are skipped rather than copied, so a skill cannot point the plugin at a file outside its own tree.
 * Ephemeral like resolveProjectSkills: a fresh mkdtemp per call, and the caller MUST await the
 * returned `cleanup()` in its finally. Best-effort, never throws.
 */
export async function resolveRepoLocalSkills(repos: Array<{ repoName: string; dir: string }>, logger?: any): Promise<ResolvedSkills> {
  const candidates: Array<{ repoName: string; src: string }> = [];
  for (const r of repos ?? []) {
    if (!r?.dir || !r?.repoName) continue;
    const src = join(r.dir, '.claude', 'skills');
    try { if ((await stat(src)).isDirectory()) candidates.push({ repoName: r.repoName, src }); } catch { /* no skills dir */ }
  }
  if (candidates.length === 0) return { plugins: [], cleanup: async () => {} };
  const root = await mkdtemp(join(tmpdir(), 'se-repo-skills-'));
  const cleanup = async () => { await rm(root, { recursive: true, force: true }).catch(() => {}); };
  const plugins: ResolvedSkills['plugins'] = [];
  const used = new Set<string>();
  try {
    for (const c of candidates) {
      const name = repoLocalPluginName(c.repoName);
      // Two workspace repos can share a name (an upstream and its fork). Merging their skills into
      // one plugin would silently serve the wrong repo's version, so the second one is skipped.
      if (used.has(name)) { logger?.warn?.('se: repo-local skills plugin name collision — skipped', { repo: c.repoName, plugin: name }); continue; }
      used.add(name);
      const dir = join(root, name);
      await mkdir(join(dir, '.claude-plugin'), { recursive: true });
      await cp(c.src, join(dir, 'skills'), { recursive: true, filter: (p) => !lstatSync(p).isSymbolicLink() });
      await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({
        name, description: `Skills from the ${c.repoName} repository's own .claude/skills directory`, skills: './skills/',
      }, null, 2));
      plugins.push({ type: 'local', path: dir, skipMcpDiscovery: true });
    }
  } catch (err: any) {
    logger?.warn?.('se: repo-local skills resolve failed', { error: String(err?.message ?? err) });
    await cleanup();
    return { plugins: [], cleanup: async () => {} };
  }
  return { plugins, cleanup };
}
