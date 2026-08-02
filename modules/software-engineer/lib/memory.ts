// @ts-nocheck
/**
 * Project memory — durable, per-PROJECT engineering knowledge. ONE wiki use_case per project
 * (`se-<projectId>`), shared across all the project's repos and every run. Backed by the AI module's
 * wiki over its JWT-exempt internal API, authenticated with the service-role key. SOFT dependency:
 * if the AI module / wiki is absent, every call no-ops and the pipeline runs without memory.
 *
 * Cross-project sharing is NATIVE: linking project L to source S writes a wiki GRANT
 * (grantor `se-<S>` → grantee `se-<L>`, read-only), so recall/search with scope='shared'
 * transparently include S's APPROVED memory. Grants are directional (L reads S ≠ S reads L).
 *
 * Recall is RAG (hybrid search → top-k relevant pages, read in full), not a full dump; a run also
 * gets on-demand `wiki_search`/`wiki_read` tools (see memory-tools.ts) to pull more when it needs to.
 *
 * Memory-poisoning defence (reflect derives from the attacker-influenceable issue/spec): reflect
 * writes only to a PENDING slug; an admin promotes it to live via approveMemory. Recall never
 * surfaces any project's pending page.
 */
const BASE = () => process.env.GATEWAZE_INTERNAL_API_URL || 'http://api:3002';
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/** The wiki use_case that holds a project's memory. One per project → per-project git-sync repo
 *  and native grant-based cross-project sharing. */
export const useCaseFor = (projectId: string): string => `se-${projectId}`;
/** Inverse of useCaseFor — the projectId a `se-<uuid>` use_case belongs to ('' if not one). */
export const projectIdFromUseCase = (useCase: string): string =>
  /^se-[0-9a-fA-F-]{36}$/.test(String(useCase ?? '')) ? String(useCase).slice(3) : '';

const MEMORY_SLUG = 'memory';
const PENDING_SLUG = 'memory-pending';

const intEnv = (k: string, d: number): number => {
  const n = parseInt(process.env[k] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};
// RAG recall budget. Retrieve the top-K relevant pages and include them up to a total char cap;
// the agent pulls anything else on demand via wiki_read. All env-tunable.
const RECALL_K = intEnv('SE_MEMORY_RECALL_K', 8);
export const RECALL_CHARS = intEnv('SE_MEMORY_RECALL_CHARS', 16000);
const PER_PAGE_CHARS = intEnv('SE_MEMORY_PER_PAGE_CHARS', 4000);

async function wiki(path: string, init?: RequestInit) {
  const r = await fetch(`${BASE()}/api/modules/ai${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-gatewaze-internal-key': KEY(), ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`wiki ${path} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}

/** Ensure the project's memory use_case exists (needs the ai module + service-role). Best-effort. */
export async function ensureMemoryUseCase(sb: unknown, projectId: string, projectName?: string): Promise<boolean> {
  if (!projectId) return false;
  try {
    await sb.from('ai_use_cases').upsert(
      { id: useCaseFor(projectId), label: `SE memory — ${projectName || projectId}`, default_model: 'claude-opus-4-8' },
      { onConflict: 'id', ignoreDuplicates: true },
    );
    return true;
  } catch {
    return false; // ai module not present → memory disabled
  }
}

/** Slug prefix for spec pages awaiting human approval (see writeSpecMemory / approveSpec). */
const SPEC_PENDING_PREFIX = 'specs-pending/';

/** True for the live/imported pages recall may surface — i.e. NOT any project's pending
 *  reflect proposal and NOT a spec still awaiting approval. Exported as the SINGLE source of
 *  truth for the pending-content gate — memory-tools.ts imports it for wiki_search/wiki_read. */
export const isRecallable = (slug: string): boolean => {
  const s = String(slug ?? '');
  return s !== PENDING_SLUG && !s.startsWith(SPEC_PENDING_PREFIX);
};

/**
 * RAG recall — hybrid-search the project's memory (and any GRANTED source projects, via scope=granted)
 * for `opts.query`, then read the top-k relevant pages in full up to the char budget. Approved pages
 * only (pending is never surfaced). Falls back to a bounded list of the project's own live pages when
 * no query is given. '' if nothing / the wiki is unavailable.
 */
export async function recallMemory(projectId: string, opts: { query?: string } = {}): Promise<string> {
  if (!projectId) return '';
  const uc = useCaseFor(projectId);
  const query = String(opts.query ?? '').trim().slice(0, 600);
  try {
    let slugs: Array<{ use_case: string; slug: string; title?: string }> = [];
    if (query) {
      const r = await wiki(`/internal/wiki/search?use_case=${encodeURIComponent(uc)}&q=${encodeURIComponent(query)}&k=${RECALL_K}&scope=granted`);
      slugs = (r?.results ?? []).map((h: Record<string, unknown>) => ({ use_case: String(h.use_case ?? uc), slug: String(h.slug), title: h.title as string | undefined }));
    } else {
      const l = await wiki(`/internal/wiki/list?use_case=${encodeURIComponent(uc)}&limit=${RECALL_K}`);
      slugs = (l?.pages ?? []).map((p: Record<string, unknown>) => ({ use_case: uc, slug: String(p.slug), title: p.title as string | undefined }));
    }
    let out = '';
    for (const s of slugs) {
      if (!isRecallable(s.slug)) continue;
      if (out.length > RECALL_CHARS) break;
      try {
        const d = await wiki(`/internal/wiki/read?use_case=${encodeURIComponent(s.use_case)}&slug=${encodeURIComponent(s.slug)}`);
        if (d?.found) {
          const from = s.use_case && s.use_case !== uc ? ` (from linked project ${projectIdFromUseCase(s.use_case) || s.use_case})` : '';
          out += `\n\n## ${d.page?.title ?? s.title ?? s.slug}${from}\n${String(d.page?.body ?? '').slice(0, PER_PAGE_CHARS)}`;
        }
      } catch { /* skip page */ }
    }
    return out.trim();
  } catch {
    return '';
  }
}

/** Low-level upsert of one memory page under the project's use_case. Best-effort. `source` tags
 *  provenance ('model' default in the wiki; 'import' for bulk-imported operator memory). */
async function upsertMemoryPage(
  sb: unknown, projectId: string, projectName: string, slug: string, title: string, body: string, source?: string,
): Promise<boolean> {
  if (!(await ensureMemoryUseCase(sb, projectId, projectName))) return false;
  try {
    await wiki(`/internal/wiki/upsert`, {
      method: 'POST',
      body: JSON.stringify({
        use_case: useCaseFor(projectId), slug, title, body: (body ?? '').slice(0, 20000),
        category: 'se-memory', metadata: { project_id: projectId },
        ...(source ? { source } : {}),
      }),
    });
    return true;
  } catch {
    return false;
  }
}

async function readPage(projectId: string, slug: string): Promise<string> {
  try {
    const d = await wiki(`/internal/wiki/read?use_case=${encodeURIComponent(useCaseFor(projectId))}&slug=${encodeURIComponent(slug)}`);
    return d?.found ? String(d.page?.body ?? '') : '';
  } catch {
    return '';
  }
}

const pendingTitle = (n: string) => `${n || 'Project'} — engineering memory (PENDING APPROVAL)`;
const liveTitle = (n: string) => `${n || 'Project'} — engineering memory`;

/** Write a PROPOSED memory update to the pending slug — NOT visible to any run until an admin
 *  approves it (approveMemory). The reflect phase uses this. */
export async function writeMemoryPending(sb: unknown, projectId: string, projectName: string, body: string): Promise<boolean> {
  if (!body?.trim()) return false;
  return upsertMemoryPage(sb, projectId, projectName, PENDING_SLUG, pendingTitle(projectName), body);
}

/** The current pending (unapproved) proposal, '' if none. For the admin review UI. */
export async function readPendingMemory(projectId: string): Promise<string> {
  return readPage(projectId, PENDING_SLUG);
}

/** The live (approved) memory doc, '' if none. For the admin review UI. */
export async function readLiveMemory(projectId: string): Promise<string> {
  return readPage(projectId, MEMORY_SLUG);
}

/** Promote the pending proposal to live (approved) memory, then clear pending. */
export async function approveMemory(sb: unknown, projectId: string, projectName: string): Promise<boolean> {
  const pending = await readPendingMemory(projectId);
  if (!pending) return false;
  const ok = await upsertMemoryPage(sb, projectId, projectName, MEMORY_SLUG, liveTitle(projectName), pending);
  if (ok) await upsertMemoryPage(sb, projectId, projectName, PENDING_SLUG, pendingTitle(projectName), '');
  return ok;
}

/** Discard the pending proposal without promoting it. */
export async function rejectMemory(sb: unknown, projectId: string, projectName: string): Promise<boolean> {
  return upsertMemoryPage(sb, projectId, projectName, PENDING_SLUG, pendingTitle(projectName), '');
}

/** Direct live write — retained for migration/tests. reflect writes to pending; live memory
 *  changes only through approveMemory. */
export async function writeMemory(sb: unknown, projectId: string, projectName: string, body: string): Promise<boolean> {
  return upsertMemoryPage(sb, projectId, projectName, MEMORY_SLUG, liveTitle(projectName), body);
}

/** Log a run's SPEC into the project's memory — PENDING first (`specs-pending/issue-<n>`), never
 *  directly recallable. It reaches future runs' recall/wiki_search only after approval to
 *  `specs/issue-<n>`: automatically when a human MERGES the run's PR (pr-monitor calls
 *  approveSpec — the merge is the human judgment), or manually via the review panel for runs
 *  that never merge. Same memory-poisoning gate as reflect. Overwrites on review-loop
 *  revisions; the issues-repo commit history (spec.ts putFile) is the full revision log. */
export async function writeSpecMemory(
  sb: unknown, projectId: string, projectName: string, issueNumber: number, issueTitle: string, body: string,
): Promise<boolean> {
  if (!projectId || !issueNumber || !body?.trim()) return false;
  return upsertMemoryPage(
    sb, projectId, projectName,
    `${SPEC_PENDING_PREFIX}issue-${issueNumber}`,
    `Spec — issue #${issueNumber}: ${String(issueTitle ?? '').slice(0, 120)} (PENDING APPROVAL)`,
    body,
  );
}

/** Pending (unapproved) specs for the review panel: [{issue, title, body}]. Cleared entries
 *  (empty body — the approve/reject convention, same as memory-pending) are filtered out. */
export async function listPendingSpecs(projectId: string): Promise<Array<{ issue: number; title: string; body: string }>> {
  if (!projectId) return [];
  try {
    const uc = useCaseFor(projectId);
    const l = await wiki(`/internal/wiki/list?use_case=${encodeURIComponent(uc)}&prefix=${encodeURIComponent(SPEC_PENDING_PREFIX)}&limit=50`);
    const out: Array<{ issue: number; title: string; body: string }> = [];
    for (const p of l?.pages ?? []) {
      const m = /^specs-pending\/issue-(\d+)$/.exec(String(p.slug ?? ''));
      if (!m) continue;
      const body = await readPage(projectId, String(p.slug));
      if (!body.trim()) continue; // cleared → not pending
      out.push({ issue: Number(m[1]), title: String(p.title ?? '').replace(/ \(PENDING APPROVAL\)$/, ''), body });
    }
    return out.sort((a, b) => a.issue - b.issue);
  } catch {
    return [];
  }
}

/** Promote a pending spec to the recallable `specs/issue-<n>` page, then clear pending.
 *  Called automatically by pr-monitor when the run's PR merges, or manually from the review
 *  panel. No-op (false) when nothing is pending for the issue. */
export async function approveSpec(sb: unknown, projectId: string, projectName: string, issueNumber: number): Promise<boolean> {
  const pendingSlug = `${SPEC_PENDING_PREFIX}issue-${issueNumber}`;
  let title = `Spec — issue #${issueNumber}`;
  let body = '';
  try {
    const d = await wiki(`/internal/wiki/read?use_case=${encodeURIComponent(useCaseFor(projectId))}&slug=${encodeURIComponent(pendingSlug)}`);
    if (d?.found) {
      body = String(d.page?.body ?? '');
      title = String(d.page?.title ?? title).replace(/ \(PENDING APPROVAL\)$/, '') || title;
    }
  } catch { return false; }
  if (!body.trim()) return false;
  const ok = await upsertMemoryPage(sb, projectId, projectName, `specs/issue-${issueNumber}`, title, body);
  if (ok) await upsertMemoryPage(sb, projectId, projectName, pendingSlug, `${title} (PENDING APPROVAL)`, '');
  return ok;
}

/** Discard a pending spec without promoting it. */
export async function rejectSpec(sb: unknown, projectId: string, projectName: string, issueNumber: number): Promise<boolean> {
  const pendingSlug = `${SPEC_PENDING_PREFIX}issue-${issueNumber}`;
  return upsertMemoryPage(sb, projectId, projectName, pendingSlug, `Spec — issue #${issueNumber} (PENDING APPROVAL)`, '');
}

// ── Linked memory sources (native wiki grants) ────────────────────────────────────────────────
// Project L "links" source project S so L's runs also recall S's approved memory. Implemented as a
// read grant grantor(se-<S>) → grantee(se-<L>); recall/search with scope='shared' then include S.

/** Link `sourceProjectId`'s approved memory into `projectId`'s recall. Directional. Best-effort. */
export async function linkMemorySource(sb: unknown, projectId: string, sourceProjectId: string): Promise<boolean> {
  if (!projectId || !sourceProjectId || projectId === sourceProjectId) return false;
  try {
    // The source's use_case must exist for the grant to resolve (own is ensured on write).
    await ensureMemoryUseCase(sb, sourceProjectId);
    await sb.from('ai_wiki_grant').upsert(
      { grantee_use_case: useCaseFor(projectId), grantor_use_case: useCaseFor(sourceProjectId), can_read: true, can_write: false },
      { onConflict: 'grantee_use_case,grantor_use_case' },
    );
    return true;
  } catch {
    return false;
  }
}

/** Remove a previously linked memory source. Best-effort. */
export async function unlinkMemorySource(sb: unknown, projectId: string, sourceProjectId: string): Promise<boolean> {
  try {
    await sb.from('ai_wiki_grant').delete()
      .eq('grantee_use_case', useCaseFor(projectId))
      .eq('grantor_use_case', useCaseFor(sourceProjectId));
    return true;
  } catch {
    return false;
  }
}

/** The source PROJECT IDs `projectId` currently recalls from (parsed back from grantor use_cases). */
export async function listMemorySources(sb: unknown, projectId: string): Promise<string[]> {
  if (!projectId) return [];
  try {
    const { data } = await sb.from('ai_wiki_grant').select('grantor_use_case')
      .eq('grantee_use_case', useCaseFor(projectId)).eq('can_read', true);
    return (data ?? []).map((r: Record<string, unknown>) => projectIdFromUseCase(String(r.grantor_use_case))).filter(Boolean);
  } catch {
    return [];
  }
}
