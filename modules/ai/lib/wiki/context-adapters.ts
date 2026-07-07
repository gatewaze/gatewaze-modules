/**
 * Wiki "context" mode — deterministic recall/persist for structured-output
 * recipes. spec-ai-wiki-runtime-integration.md §4.3–4.5.
 *
 * A structured-output recipe (e.g. lunch-and-learn-writeup) must NOT carry
 * agentic wiki tools (they suppress Goose's `recipe__final_output` call — §4.1),
 * yet may still want durable memory. `context` mode delivers it out-of-band:
 * the runner (run-recipe-goose) RECALLS relevant pages into `{{ wiki_context }}`
 * before the model turn and PERSISTS the result after success. A per-use-case
 * `WikiContextAdapter` maps run params → a recall query and a run result → a
 * wiki page; the runner owns the mechanism, adapters own the specifics.
 */

import {
  searchPages,
  upsertPage,
  type WikiDbClient,
  type EmbedFn,
  type SearchResult,
} from './repository.js';

export interface WikiContextAdapter {
  /**
   * Build the recall query from this run's params, or return null to skip
   * recall (e.g. a judge/finalize sub-run that should not recall). `namespace`
   * (a slug prefix) narrows the search to a sub-collection.
   */
  recallQuery(params: Record<string, unknown>): { text: string; namespace?: string; topK?: number } | null;
  /**
   * Map a successful run result to the page to persist, or return null to skip
   * persist. Called on terminal success (auto for single-shot recipes; invoked
   * explicitly by a multi-sub-run coordinator — §5.5).
   */
  persistPage(
    result: Record<string, unknown>,
    params: Record<string, unknown>,
  ): { slug: string; title: string; body: string; summary?: string; metadata?: Record<string, unknown> } | null;
}

const registry = new Map<string, WikiContextAdapter>();

export function registerWikiContextAdapter(useCaseId: string, adapter: WikiContextAdapter): void {
  registry.set(useCaseId, adapter);
}
export function getWikiContextAdapter(useCaseId: string): WikiContextAdapter | null {
  return registry.get(useCaseId) ?? null;
}

export type WikiMode = 'tools' | 'context' | 'off';

/**
 * Read a use case's effective wiki participation. `wiki_enabled=false` forces
 * 'off'; else `wiki_mode` (default 'tools'). Pre-migration (no wiki_mode
 * column) falls back to the legacy boolean. spec-ai-wiki-runtime-integration.md §4.2.
 */
export async function readWikiUseCaseConfig(
  supabase: WikiDbClient,
  useCaseId: string,
): Promise<{ mode: WikiMode; persistEnabled: boolean }> {
  if (process.env.WIKI_RUNTIME_DISABLED === '1') return { mode: 'off', persistEnabled: false };
  try {
    const res = await supabase
      .from('ai_use_cases')
      .select('wiki_enabled, wiki_mode, wiki_persist_enabled')
      .eq('id', useCaseId)
      .maybeSingle();
    const row = (res.data as { wiki_enabled?: boolean; wiki_mode?: WikiMode; wiki_persist_enabled?: boolean } | null) ?? null;
    const mode: WikiMode = row?.wiki_enabled === false ? 'off' : (row?.wiki_mode ?? 'tools');
    return { mode, persistEnabled: row?.wiki_persist_enabled ?? true };
  } catch {
    // Pre-migration fallback: legacy boolean only.
    try {
      const res = await supabase.from('ai_use_cases').select('wiki_enabled').eq('id', useCaseId).maybeSingle();
      const row = (res.data as { wiki_enabled?: boolean } | null) ?? null;
      return { mode: row?.wiki_enabled === false ? 'off' : 'tools', persistEnabled: true };
    } catch {
      return { mode: 'tools', persistEnabled: true };
    }
  }
}

function makeEmbed(supabase: WikiDbClient): EmbedFn {
  return async (texts: string[], useCase: string): Promise<number[][]> => {
    const { aiEmbed } = await import('../runner.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await aiEmbed({ supabase } as any, { useCase, userId: null, texts, systemRun: true });
    return r.vectors;
  };
}

// ~4 chars/token approximation for the recall budget cap (§4.4). Cheap and
// dependency-free; the budget is a soft ceiling, not a billing boundary.
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Fixed-format, bounded recall block (§4.4): a heading + ≤K entries
 * (`### <title> — [<slug>]` + ≤300-char excerpt), truncated to `budgetTokens`,
 * with a trailing omitted-count line. Empty ⇒ `(none)`.
 */
export function renderWikiContext(results: SearchResult[], budgetTokens: number): string {
  if (!results.length) return '(none)';
  const header = '## Related prior write-ups';
  const parts: string[] = [header];
  let used = estimateTokens(header);
  let shown = 0;
  for (const r of results) {
    const excerpt = (r.summary ?? r.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const entry = `\n\n### ${r.title} — [${r.slug}]\n${excerpt}`;
    const t = estimateTokens(entry);
    if (used + t > budgetTokens && shown > 0) break;
    parts.push(entry);
    used += t;
    shown++;
  }
  const omitted = results.length - shown;
  if (omitted > 0) parts.push(`\n\n> (${omitted} older match${omitted === 1 ? '' : 'es'} omitted)`);
  return parts.join('');
}

const DEFAULT_TOPK = Number(process.env.WIKI_CONTEXT_TOPK ?? 5);
const DEFAULT_BUDGET = Number(process.env.WIKI_CONTEXT_TOKEN_BUDGET ?? 2000);

/**
 * Recall: hybrid-search the use case's wiki for pages matching the adapter's
 * query, scoped to `self` (own wiki) and optionally a slug-prefix namespace.
 * Best-effort — returns `(none)` on no query / no hits / error.
 */
export async function recallWikiContext(
  supabase: WikiDbClient,
  useCaseId: string,
  adapter: WikiContextAdapter,
  params: Record<string, unknown>,
  opts: { topK?: number; budgetTokens?: number } = {},
): Promise<{ text: string; hitCount: number }> {
  try {
    const q = adapter.recallQuery(params);
    if (!q || !q.text.trim()) return { text: '(none)', hitCount: 0 };
    const k = q.topK ?? opts.topK ?? DEFAULT_TOPK;
    const results = await searchPages(
      supabase,
      { useCase: useCaseId, query: q.text, k: k * 2, mode: 'hybrid', scope: 'self' },
      makeEmbed(supabase),
    );
    const filtered = (q.namespace ? results.filter((r) => r.slug.startsWith(q.namespace as string)) : results).slice(0, k);
    return { text: renderWikiContext(filtered, opts.budgetTokens ?? DEFAULT_BUDGET), hitCount: filtered.length };
  } catch {
    return { text: '(none)', hitCount: 0 };
  }
}

/**
 * Persist: upsert the adapter-derived page (idempotent by slug + the wiki
 * layer's optimistic lock). Best-effort — never throws; returns the outcome.
 */
export async function persistWikiPage(
  supabase: WikiDbClient,
  useCaseId: string,
  adapter: WikiContextAdapter,
  result: Record<string, unknown>,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; slug?: string; error?: string; skipped?: boolean }> {
  try {
    const page = adapter.persistPage(result, params);
    if (!page) return { ok: true, skipped: true };
    const r = await upsertPage(
      supabase,
      {
        useCase: useCaseId,
        slug: page.slug,
        title: page.title,
        body: page.body,
        summary: page.summary ?? null,
        metadata: page.metadata ?? {},
        source: 'model',
      },
      makeEmbed(supabase),
    );
    return { ok: r.ok, slug: r.slug, error: r.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
