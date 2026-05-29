/**
 * Wiki repository — the shared DB core used by the MCP server, the admin API
 * routes, and the sync workers. spec-ai-memory-wiki.md §4–§8.
 *
 * The embedder is injected (`EmbedFn`) so callers with a RunnerContext (API /
 * workers) can embed via `aiEmbed` (cost-tracked through the ProviderRouter),
 * while the standalone MCP process can pass `null` and let an embed sweep
 * backfill — i.e. embedding is never hard-wired here. Pure decision logic
 * (row shaping, link diffing, where-filter parsing) is split out for unit tests;
 * the DB orchestration is thin glue over the PostgREST query builder.
 */

import { validateSlug } from './slug.js';
import { parseLinksForPage, type LinkRef } from './links.js';
import { contentHash } from './hash.js';
import { fuseRRF, type RankedItem } from './rrf.js';

// Minimal structural view of the Supabase/PostgREST client this module needs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WikiDbClient = { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };

/** Embed N texts → N vectors for a use case (caller wires aiEmbed); null ⇒ defer. */
export type EmbedFn = ((texts: string[], useCase: string) => Promise<number[][]>) | null;

export const WIKI_PAGE_COLS =
  'id, use_case, slug, title, body, summary, category, metadata, kind, embedded_at, content_hash, git_synced_hash, source, conflict, conflict_detail, version, created_at, updated_at, deleted_at';

export interface UpsertPageInput {
  useCase: string;
  slug: string;
  title: string;
  body: string;
  summary?: string | null;
  category?: string | null;
  metadata?: Record<string, unknown>;
  source?: 'model' | 'human' | 'import';
  userId?: string | null;
  messageId?: string | null;
}

export interface UpsertResult {
  ok: boolean;
  slug: string;
  version: number;
  error?: string;
  warning?: string;
}

// --- pure helpers (unit-tested) --------------------------------------------

/** The column set written on a page upsert (excludes server-managed change_seq/version bumps). */
export function buildUpsertRow(input: UpsertPageInput, changeSeq: number): Record<string, unknown> {
  return {
    use_case: input.useCase,
    slug: input.slug,
    title: input.title,
    body: input.body,
    summary: input.summary ?? null,
    category: input.category ?? null,
    metadata: input.metadata ?? {},
    content_hash: contentHash(input.title, input.body),
    change_seq: changeSeq,
    source: input.source ?? 'model',
    written_by_message_id: input.messageId ?? null,
    created_by: input.userId ?? null,
    deleted_at: null, // (re)activate on write — reactivates a tombstone (§5.1)
  };
}

/** Link rows to persist for a page (from parsed body). */
export function linkRowsFor(useCase: string, slug: string, links: LinkRef[]): Array<Record<string, string>> {
  return links.map((l) => ({
    from_use_case: useCase,
    from_slug: slug,
    to_use_case: l.to_use_case,
    to_slug: l.to_slug,
  }));
}

/** Validate + coerce a `where` metadata filter (equality only, string/number/bool). */
export function parseWhereFilter(where: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!where || typeof where !== 'object' || Array.isArray(where)) return out;
  for (const [k, v] of Object.entries(where as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(k)) continue; // guard the jsonb key
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

// --- orchestration ----------------------------------------------------------

/** Resolve the set of use cases a caller may read (self ∪ can_read grants). */
export async function readableUseCases(client: WikiDbClient, useCase: string): Promise<string[]> {
  const res = await client
    .from('ai_wiki_grant')
    .select('grantor_use_case')
    .eq('grantee_use_case', useCase)
    .eq('can_read', true);
  const granted = (res?.data as Array<{ grantor_use_case: string }> | null) ?? [];
  return [useCase, ...granted.map((g) => g.grantor_use_case)];
}

export async function upsertPage(client: WikiDbClient, input: UpsertPageInput, embed: EmbedFn): Promise<UpsertResult> {
  const slugCheck = validateSlug(input.slug);
  if (!slugCheck.ok) return { ok: false, slug: input.slug, version: 0, error: `invalid_slug: ${slugCheck.reason}` };

  // Atomic per-use-case change_seq allocation (also ensures the sync_state row).
  const seqRes = await client.rpc('ai_wiki_alloc_seq', { p_use_case: input.useCase });
  if (seqRes.error) return { ok: false, slug: input.slug, version: 0, error: seqRes.error.message };
  const changeSeq = Number(seqRes.data);

  // Read current version (optimistic-lock bump + reactivation).
  const cur = await client
    .from('ai_wiki_page')
    .select('id, version, deleted_at')
    .eq('use_case', input.useCase)
    .eq('slug', input.slug)
    .maybeSingle();
  const exists = !!cur?.data;
  const nextVersion = exists ? Number((cur.data as { version: number }).version) + 1 : 1;

  const row = { ...buildUpsertRow(input, changeSeq), version: nextVersion };
  const write = await client
    .from('ai_wiki_page')
    .upsert(row, { onConflict: 'use_case,slug' })
    .select('id, version')
    .maybeSingle();
  if (write.error) return { ok: false, slug: input.slug, version: 0, error: write.error.message };

  // Rebuild link graph from the body (delete-then-insert; links are derived).
  const links = parseLinksForPage(input.body, input.useCase, input.slug);
  await client.from('ai_wiki_link').delete().eq('from_use_case', input.useCase).eq('from_slug', input.slug);
  if (links.length > 0) {
    await client.from('ai_wiki_link').insert(linkRowsFor(input.useCase, input.slug, links));
  }

  // Embedding: synchronous if an embedder was provided, else deferred (sweep).
  let warning: string | undefined;
  if (embed) {
    try {
      const [vec] = await embed([`${input.title}\n${input.body}`], input.useCase);
      if (vec) {
        await client
          .from('ai_wiki_page')
          .update({ embedding: vec, embedding_model: 'text-embedding-3-small', embedded_at: new Date().toISOString() })
          .eq('use_case', input.useCase)
          .eq('slug', input.slug);
      }
    } catch {
      warning = 'embed_deferred';
    }
  } else {
    warning = 'embed_deferred';
  }

  return { ok: true, slug: input.slug, version: nextVersion, ...(warning ? { warning } : {}) };
}

export async function readPage(client: WikiDbClient, useCase: string, slug: string): Promise<Record<string, unknown> | null> {
  const res = await client
    .from('ai_wiki_page')
    .select(WIKI_PAGE_COLS)
    .eq('use_case', useCase)
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle();
  if (res.error || !res.data) return null;
  const links = await client
    .from('ai_wiki_link')
    .select('to_use_case, to_slug')
    .eq('from_use_case', useCase)
    .eq('from_slug', slug);
  return { ...(res.data as Record<string, unknown>), links: (links?.data as unknown[]) ?? [] };
}

export interface ListOpts {
  prefix?: string;
  category?: string;
  where?: unknown;
  limit?: number;
}

export async function listPages(client: WikiDbClient, useCase: string, opts: ListOpts = {}): Promise<Array<Record<string, unknown>>> {
  let q = client
    .from('ai_wiki_page')
    .select('id, slug, title, summary, category, metadata, updated_at, conflict')
    .eq('use_case', useCase)
    .is('deleted_at', null)
    .order('slug', { ascending: true })
    .limit(Math.min(opts.limit ?? 100, 1000));
  if (opts.prefix) q = q.like('slug', `${String(opts.prefix).replace(/[%_]/g, '')}%`);
  if (opts.category) q = q.eq('category', opts.category);
  for (const [k, v] of Object.entries(parseWhereFilter(opts.where))) {
    q = q.eq(`metadata->>${k}`, String(v));
  }
  const res = await q;
  return (res?.data as Array<Record<string, unknown>>) ?? [];
}

export async function softDeletePage(client: WikiDbClient, useCase: string, slug: string): Promise<boolean> {
  const seqRes = await client.rpc('ai_wiki_alloc_seq', { p_use_case: useCase });
  if (seqRes.error) return false;
  const res = await client
    .from('ai_wiki_page')
    .update({ deleted_at: new Date().toISOString(), change_seq: Number(seqRes.data) })
    .eq('use_case', useCase)
    .eq('slug', slug);
  return !res.error;
}

export interface SearchOpts {
  useCase: string;
  query: string;
  k?: number;
  mode?: 'hybrid' | 'keyword' | 'semantic';
  scope?: 'self' | 'granted' | 'all';
  kinds?: string[];
}

export interface SearchResult {
  use_case: string;
  slug: string;
  kind: string;
  title: string;
  summary: string | null;
  snippet: string;
  score: number;
}

/**
 * Hybrid search. Keyword via FTS RPC; semantic via the `match` RPC over the
 * query embedding (requires `embed`). Falls back to keyword-only when no
 * embedder or mode='keyword'. Cross-wiki scope filters to the readable set.
 */
export async function searchPages(client: WikiDbClient, opts: SearchOpts, embed: EmbedFn): Promise<SearchResult[]> {
  const k = Math.min(opts.k ?? 5, 50);
  const mode = opts.mode ?? 'hybrid';
  const scope = opts.scope ?? 'self';
  const useCases = scope === 'self' ? [opts.useCase] : await readableUseCases(client, opts.useCase);

  const lists: Array<Array<RankedItem & SearchResult>> = [];
  const rowToResult = (r: Record<string, unknown>): RankedItem & SearchResult => ({
    use_case: String(r.use_case),
    slug: String(r.slug),
    kind: String(r.kind ?? 'page'),
    title: String(r.title ?? ''),
    summary: (r.summary as string | null) ?? null,
    snippet: String(r.snippet ?? r.summary ?? ''),
    score: 0,
  });

  if (mode !== 'semantic') {
    // Keyword via the PostgREST full-text operator over pages (raw is
    // semantic-only). websearch parses the user query safely server-side.
    const kw = await client
      .from('ai_wiki_page')
      .select('use_case, slug, kind, title, summary')
      .in('use_case', useCases)
      .is('deleted_at', null)
      .textSearch('search_tsv', opts.query, { type: 'websearch' })
      .limit(k * 2);
    if (!kw.error && Array.isArray(kw.data)) lists.push((kw.data as Array<Record<string, unknown>>).map(rowToResult));
  }

  if (mode !== 'keyword' && embed) {
    try {
      const [qvec] = await embed([opts.query], opts.useCase);
      if (qvec) {
        const sem = await client.rpc('ai_wiki_match', {
          p_use_cases: useCases,
          p_query_vec: qvec,
          p_kinds: opts.kinds ?? ['page'],
          p_limit: k * 2,
        });
        if (!sem.error && Array.isArray(sem.data)) lists.push((sem.data as Array<Record<string, unknown>>).map(rowToResult));
      }
    } catch {
      /* semantic unavailable → keyword-only */
    }
  }

  // Down-weight raw-source list members slightly so synthesis pages rank first.
  return fuseRRF(lists)
    .slice(0, k)
    .map((f) => ({ ...f.item, score: f.score }));
}

export async function readSource(client: WikiDbClient, useCase: string, slug: string): Promise<Record<string, unknown> | null> {
  const res = await client
    .from('ai_wiki_raw_source')
    .select('id, use_case, slug, source_type, uri, connector, title, content, metadata, fetched_at')
    .eq('use_case', useCase)
    .eq('slug', slug)
    .is('expired_at', null)
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return res.error ? null : ((res.data as Record<string, unknown>) ?? null);
}

export async function listSources(client: WikiDbClient, useCase: string, opts: { prefix?: string; limit?: number } = {}): Promise<Array<Record<string, unknown>>> {
  let q = client
    .from('ai_wiki_raw_source')
    .select('id, slug, source_type, uri, title, fetched_at')
    .eq('use_case', useCase)
    .is('expired_at', null)
    .order('fetched_at', { ascending: false })
    .limit(Math.min(opts.limit ?? 100, 1000));
  if (opts.prefix) q = q.like('slug', `${String(opts.prefix).replace(/[%_]/g, '')}%`);
  const res = await q;
  return (res?.data as Array<Record<string, unknown>>) ?? [];
}
