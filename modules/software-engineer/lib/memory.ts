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

/** Write/replace a project's memory doc. Best-effort (ensures the use_case first). */
export async function writeMemory(sb: unknown, projectId: string, projectName: string, body: string): Promise<boolean> {
  if (!projectId || !body?.trim()) return false;
  if (!(await ensureMemoryUseCase(sb))) return false;
  try {
    await wiki(`/internal/wiki/upsert`, {
      method: 'POST',
      body: JSON.stringify({
        use_case: USECASE,
        slug: slugFor(projectId),
        title: `${projectName || 'Project'} — engineering memory`,
        body: body.slice(0, 20000),
        category: 'se-memory',
        metadata: { project_id: projectId },
      }),
    });
    return true;
  } catch {
    return false;
  }
}
