// @ts-nocheck
/**
 * Project memory — durable, per-PROJECT engineering knowledge shared across its repos and every
 * future run. Backed by the AI module's wiki (one page per project) via its JWT-exempt internal API,
 * authenticated with the service-role key. SOFT dependency: if the AI module / wiki isn't present,
 * every call no-ops and the pipeline runs without memory.
 *
 * One shared wiki use_case ('software-engineer') holds all projects' memory, namespaced by slug
 * `p/<projectId>/memory`. (Per-project git-sync/portability is a wiki-config layer on top.)
 */
const BASE = () => process.env.GATEWAZE_INTERNAL_API_URL || 'http://api:3002';
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USECASE = 'software-engineer';
const slugFor = (projectId: string) => `p/${projectId}/memory`;
// Proposed memory from the reflect phase lands here; it is NOT injected into any
// run until an admin promotes it to the live slug via approveMemory. This is the
// human-approval gate for the memory-poisoning risk (reflect derives from the
// attacker-influenceable issue/spec).
const pendingSlugFor = (projectId: string) => `p/${projectId}/memory-pending`;

async function wiki(path: string, init?: RequestInit) {
  const r = await fetch(`${BASE()}/api/modules/ai${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-gatewaze-internal-key': KEY(), ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`wiki ${path} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}

/** Ensure the shared SE memory use_case exists (needs the ai module + service-role). Best-effort. */
export async function ensureMemoryUseCase(sb: unknown): Promise<boolean> {
  try {
    await sb.from('ai_use_cases').upsert(
      { id: USECASE, label: 'Software Engineer memory', default_model: 'claude-opus-4-8' },
      { onConflict: 'id', ignoreDuplicates: true },
    );
    return true;
  } catch {
    return false; // ai module not present → memory disabled
  }
}

/** Recall a project's memory — aggregates ALL pages under the project's prefix (the reflect doc +
 *  any imported pages), capped. '' if none / wiki unavailable. */
export async function recallMemory(projectId: string): Promise<string> {
  if (!projectId) return '';
  try {
    const list = await wiki(`/internal/wiki/list?use_case=${USECASE}&prefix=${encodeURIComponent(`p/${projectId}/`)}&limit=40`);
    const pages = list?.pages ?? [];
    if (pages.length === 0) return '';
    let out = '';
    for (const pg of pages) {
      // Never inject the PENDING (unapproved) proposal into a run — only human-
      // approved (live) pages reach a future run's prompt.
      if (String(pg.slug ?? '').endsWith('/memory-pending')) continue;
      if (out.length > 40000) break;
      try {
        const d = await wiki(`/internal/wiki/read?use_case=${USECASE}&slug=${encodeURIComponent(pg.slug)}`);
        if (d?.found) out += `\n\n## ${pg.title ?? pg.slug}\n${String(d.page?.body ?? '').slice(0, 8000)}`;
      } catch { /* skip page */ }
    }
    return out.trim();
  } catch {
    return '';
  }
}

/** Low-level upsert of one memory page. Best-effort (ensures the use_case first). */
async function upsertMemoryPage(sb: unknown, projectId: string, slug: string, title: string, body: string): Promise<boolean> {
  if (!(await ensureMemoryUseCase(sb))) return false;
  try {
    await wiki(`/internal/wiki/upsert`, {
      method: 'POST',
      body: JSON.stringify({
        use_case: USECASE, slug, title, body: (body ?? '').slice(0, 20000),
        category: 'se-memory', metadata: { project_id: projectId },
      }),
    });
    return true;
  } catch {
    return false;
  }
}

const pendingTitle = (projectName: string) => `${projectName || 'Project'} — engineering memory (PENDING APPROVAL)`;
const liveTitle = (projectName: string) => `${projectName || 'Project'} — engineering memory`;

/** Write a PROPOSED memory update to the pending slug. It is NOT visible to any
 *  run until an admin approves it (approveMemory). The reflect phase uses this. */
export async function writeMemoryPending(sb: unknown, projectId: string, projectName: string, body: string): Promise<boolean> {
  if (!projectId || !body?.trim()) return false;
  return upsertMemoryPage(sb, projectId, pendingSlugFor(projectId), pendingTitle(projectName), body);
}

async function readPage(projectId: string, slug: string): Promise<string> {
  if (!projectId) return '';
  try {
    const d = await wiki(`/internal/wiki/read?use_case=${USECASE}&slug=${encodeURIComponent(slug)}`);
    return d?.found ? String(d.page?.body ?? '').trim() : '';
  } catch {
    return '';
  }
}

/** The current pending (unapproved) proposal, '' if none. For the admin review UI. */
export async function readPendingMemory(projectId: string): Promise<string> {
  return readPage(projectId, pendingSlugFor(projectId));
}

/** The live (approved) memory doc, '' if none. For the admin review UI. */
export async function readLiveMemory(projectId: string): Promise<string> {
  return readPage(projectId, slugFor(projectId));
}

/** Promote the pending proposal to live (approved) memory, then clear pending.
 *  This is the ONLY path that makes a memory update visible to future runs. */
export async function approveMemory(sb: unknown, projectId: string, projectName: string): Promise<boolean> {
  const pending = await readPendingMemory(projectId);
  if (!pending) return false;
  const ok = await upsertMemoryPage(sb, projectId, slugFor(projectId), liveTitle(projectName), pending);
  if (ok) await upsertMemoryPage(sb, projectId, pendingSlugFor(projectId), pendingTitle(projectName), ''); // clear
  return ok;
}

/** Discard the pending proposal without promoting it. */
export async function rejectMemory(sb: unknown, projectId: string, projectName: string): Promise<boolean> {
  return upsertMemoryPage(sb, projectId, pendingSlugFor(projectId), pendingTitle(projectName), '');
}

/** Direct live write — retained for migration/tests. reflect now writes to
 *  pending via writeMemoryPending; live memory changes only through approveMemory. */
export async function writeMemory(sb: unknown, projectId: string, projectName: string, body: string): Promise<boolean> {
  if (!projectId || !body?.trim()) return false;
  return upsertMemoryPage(sb, projectId, slugFor(projectId), liveTitle(projectName), body);
}
