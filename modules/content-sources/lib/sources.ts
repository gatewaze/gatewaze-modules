/**
 * Shared server-side logic for creating and changing discovery sources, used
 * by the admin API, the public API and the MCP tools so the rules live once.
 *
 * Every write goes through an allowlist of fields; enum fields are validated
 * here before any query is built. Nothing here reads req.body directly.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
// Plain-JS libraries shared with the scraper worker (tsconfig allowJs).
import { resolveFeed, isCrossDomain } from './resolve-feed.js';
import { policeUrl } from './http.js';
import { normalizeUrl } from './normalize-url.js';

export const SOURCE_KINDS = ['feed', 'sitemap', 'html'] as const;
export const SOURCE_STATUSES = ['pending', 'active', 'paused', 'dead'] as const;
export const EGRESS_MODES = ['direct', 'residential'] as const;
export const ADDED_VIA = ['admin_ui', 'api', 'mcp', 'slack', 'import'] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** Columns the public surfaces may return. ETag/Last-Modified stay internal. */
export const PUBLIC_SOURCE_FIELDS = [
  'id', 'kind', 'site_url', 'feed_url', 'path_prefix', 'scraper_id', 'foundation', 'project', 'content_category',
  'status', 'egress', 'egress_auto', 'egress_locked', 'last_run_at', 'last_ok_at', 'last_entry_at',
  'last_error', 'consecutive_failures', 'is_canary', 'added_via', 'note', 'deactivated_at',
  'created_at', 'updated_at',
] as const;

export class SourceError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const text = (v: unknown, max: number, field: string, required = false): string | null => {
  if (v == null || v === '') {
    if (required) throw new SourceError(400, 'VALIDATION_ERROR', `${field} is required`);
    return null;
  }
  if (typeof v !== 'string') throw new SourceError(400, 'VALIDATION_ERROR', `${field} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new SourceError(400, 'VALIDATION_ERROR', `${field} is longer than ${max} characters`);
  return t;
};

const oneOf = <T extends readonly string[]>(v: unknown, allowed: T, field: string): T[number] | null => {
  if (v == null) return null;
  if (typeof v !== 'string' || !allowed.includes(v)) {
    throw new SourceError(400, 'VALIDATION_ERROR', `${field} must be one of ${allowed.join(', ')}`);
  }
  return v as T[number];
};

const bool = (v: unknown, field: string): boolean | null => {
  if (v == null) return null;
  if (typeof v !== 'boolean') throw new SourceError(400, 'VALIDATION_ERROR', `${field} must be a boolean`);
  return v;
};

const httpsUrl = (v: unknown, field: string, required = false): string | null => {
  const t = text(v, 2048, field, required);
  if (t == null) return null;
  try {
    return policeUrl(t).toString();
  } catch (e) {
    throw new SourceError(400, 'VALIDATION_ERROR', `${field}: ${(e as Error).message}`);
  }
};

export interface ResolveResult {
  site_url: string;
  candidates: Array<{
    feed_url: string; found_via: string; kind: string; feed_title: string; entry_count: number;
    newest_entry_at: string | null; cross_domain: boolean; is_root_index: boolean;
  }>;
  errors: string[];
}

export async function resolve(siteUrl: unknown): Promise<ResolveResult> {
  const url = httpsUrl(siteUrl, 'site_url', true) as string;
  return resolveFeed(url) as Promise<ResolveResult>;
}

export interface SubmitInput {
  site_url: unknown;
  feed_url?: unknown;
  kind?: unknown;
  path_prefix?: unknown;
  foundation?: unknown;
  project?: unknown;
  content_category?: unknown;
  note?: unknown;
  is_canary?: unknown;
  egress?: unknown;
  scraper_id?: unknown;
  /** Force a pending row even for an admin-scoped caller (the hosted MCP server sets this: its key is the deployment's, not the user's). */
  as_pending?: unknown;
}

const scraperId = (v: unknown): string | null => {
  const t = text(v, 100, 'scraper_id');
  if (t != null && !/^[a-z0-9][a-z0-9_-]*$/i.test(t)) throw new SourceError(400, 'VALIDATION_ERROR', 'scraper_id must be an identifier');
  return t;
};

export interface SubmitContext {
  /** Who is adding: a person id when known. */
  personId: string | null;
  addedVia: (typeof ADDED_VIA)[number];
  /** Admin callers activate immediately; everyone else lands pending. */
  isAdmin: boolean;
}

/**
 * Create a source. Resolves the feed when none was given. Returns the row.
 * Throws SourceError 409 "already tracked" when the normalised feed URL is
 * known, with the existing row's id.
 */
export async function submit(sb: SupabaseClient, input: SubmitInput, ctx: SubmitContext) {
  const siteUrl = httpsUrl(input.site_url, 'site_url', true) as string;
  let feedUrl = httpsUrl(input.feed_url, 'feed_url');
  let kind = oneOf(input.kind, SOURCE_KINDS, 'kind');
  const rawPrefix = httpsUrl(input.path_prefix, 'path_prefix');
  const pathPrefix = rawPrefix ? (rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`) : null;
  const foundation = text(input.foundation, 200, 'foundation');
  const project = text(input.project, 200, 'project');
  const contentCategory = text(input.content_category, 100, 'content_category');
  const note = text(input.note, 2000, 'note');
  const isCanary = bool(input.is_canary, 'is_canary') ?? false;
  const egress = oneOf(input.egress, EGRESS_MODES, 'egress') ?? 'direct';
  const extractorId = scraperId(input.scraper_id);

  let resolvedTitle: string | null = null;
  // Re-checked here even when the caller chose the feed, so a UI cannot hand
  // us a third party's feed under a site's name without the row saying so.
  let crossDomain = feedUrl ? isCrossDomain(feedUrl, siteUrl) : false;
  if (!feedUrl && kind !== 'html') {
    const r = (await resolveFeed(siteUrl)) as ResolveResult;
    const best = r.candidates[0];
    if (best) {
      feedUrl = best.feed_url;
      resolvedTitle = best.feed_title || null;
      crossDomain = best.cross_domain;
      kind = kind ?? 'feed';
    } else {
      kind = 'html';
    }
  }
  if (kind === 'sitemap' && !pathPrefix) {
    throw new SourceError(400, 'VALIDATION_ERROR', 'path_prefix is required for a sitemap source');
  }
  if ((kind ?? 'feed') === 'feed' && !feedUrl) {
    throw new SourceError(400, 'VALIDATION_ERROR', 'feed_url is required for a feed source (none could be resolved)');
  }
  kind = kind ?? 'feed';

  if (feedUrl) {
    const norm = normalizeUrl(feedUrl) as string;
    const { data: existing } = await sb
      .from('discovery_sources')
      .select('id, project, status')
      .eq('feed_url', feedUrl)
      .maybeSingle();
    const dup = existing ?? (await findByNorm(sb, norm));
    if (dup) {
      throw new SourceError(409, 'ALREADY_TRACKED', 'This feed is already tracked', { id: dup.id });
    }
  }

  const activate = shouldActivate({ kind, crossDomain, isAdmin: ctx.isAdmin, asPending: input.as_pending === true });
  const row = {
    kind,
    site_url: siteUrl,
    feed_url: feedUrl,
    path_prefix: pathPrefix,
    scraper_id: kind === 'html' ? extractorId : null,
    foundation: foundation ?? 'Unassigned',
    project: project ?? resolvedTitle ?? hostLabel(siteUrl),
    content_category: contentCategory,
    status: activate ? 'active' : 'pending',
    egress,
    is_canary: isCanary,
    added_by_person_id: ctx.personId,
    added_via: ctx.addedVia,
    note: [note, crossDomain ? 'feed is on a different domain than the site; confirm before activating' : null].filter(Boolean).join(' — ') || null,
  };
  const { data, error } = await sb.from('discovery_sources').insert(row).select(PUBLIC_SOURCE_FIELDS.join(',')).single();
  if (error) {
    if (error.code === '23505') throw new SourceError(409, 'ALREADY_TRACKED', 'This feed is already tracked');
    throw new SourceError(500, 'QUERY_ERROR', error.message);
  }
  return data as unknown as Record<string, unknown>;
}

/**
 * Activation rules for a new source. Only an admin-scoped caller activates,
 * and only a source the FeedScraper can actually run:
 *  - non-admins always land pending;
 *  - as_pending (the hosted MCP server's key is the deployment's, not the
 *    user's) forces pending;
 *  - a cross-domain feed stays pending even when the admin chose it, so a
 *    second person confirms a third party's feed under a project's name;
 *  - kind 'html' stays pending: the FeedScraper reads feeds and sitemaps only,
 *    so an html row has nothing that would run it yet.
 */
export function shouldActivate(o: { kind: SourceKind; crossDomain: boolean; isAdmin: boolean; asPending: boolean }): boolean {
  const runnable = o.kind === 'feed' || o.kind === 'sitemap';
  return o.isAdmin && runnable && !o.crossDomain && !o.asPending;
}

async function findByNorm(sb: SupabaseClient, norm: string) {
  // The unique index is on the SQL normaliser; mirror the lookup by scanning
  // candidates with the same host (cheap: a few rows) and comparing in JS.
  const host = norm.split(/[/?]/)[0];
  const { data } = await sb
    .from('discovery_sources')
    .select('id, project, status, feed_url')
    .ilike('feed_url', `%${host.replace(/[%_]/g, '')}%`)
    .limit(50);
  return (data ?? []).find((r: { feed_url: string | null }) => r.feed_url && normalizeUrl(r.feed_url) === norm) ?? null;
}

function hostLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Source';
  }
}

export interface PatchInput {
  status?: unknown; egress?: unknown; egress_locked?: unknown; foundation?: unknown; project?: unknown;
  content_category?: unknown; note?: unknown; is_canary?: unknown; feed_url?: unknown; path_prefix?: unknown; kind?: unknown;
  scraper_id?: unknown;
}

/** Admin-only field changes. Flipping egress back to direct locks it (the scraper never re-flips a locked row). */
export async function patch(sb: SupabaseClient, id: string, input: PatchInput) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new SourceError(400, 'VALIDATION_ERROR', 'invalid id');
  const upd: Record<string, unknown> = {};
  const status = oneOf(input.status, SOURCE_STATUSES, 'status');
  if (status) {
    upd.status = status;
    upd.deactivated_at = status === 'dead' || status === 'paused' ? new Date().toISOString() : null;
  }
  const egress = oneOf(input.egress, EGRESS_MODES, 'egress');
  if (egress) {
    upd.egress = egress;
    upd.egress_auto = false;
    if (egress === 'direct') upd.egress_locked = true;
  }
  const locked = bool(input.egress_locked, 'egress_locked');
  if (locked != null) upd.egress_locked = locked;
  const foundation = text(input.foundation, 200, 'foundation');
  if (foundation) upd.foundation = foundation;
  const project = text(input.project, 200, 'project');
  if (project) upd.project = project;
  if (input.content_category !== undefined) upd.content_category = text(input.content_category, 100, 'content_category');
  if (input.note !== undefined) upd.note = text(input.note, 2000, 'note');
  const canary = bool(input.is_canary, 'is_canary');
  if (canary != null) upd.is_canary = canary;
  if (input.feed_url !== undefined) {
    upd.feed_url = httpsUrl(input.feed_url, 'feed_url');
    upd.etag = null;
    upd.last_modified = null;
  }
  if (input.path_prefix !== undefined) {
    const p = httpsUrl(input.path_prefix, 'path_prefix');
    upd.path_prefix = p ? (p.endsWith('/') ? p : `${p}/`) : null;
  }
  const kind = oneOf(input.kind, SOURCE_KINDS, 'kind');
  if (kind) upd.kind = kind;
  if (kind === 'sitemap' || (upd.path_prefix === null && kind !== 'feed' && kind !== 'html')) {
    // kind=sitemap needs a prefix; check the row's existing one when the caller did not send one.
    const { data: cur } = await sb.from('discovery_sources').select('kind, path_prefix').eq('id', id).maybeSingle();
    const finalKind = kind ?? (cur as { kind?: string } | null)?.kind;
    const finalPrefix = upd.path_prefix !== undefined ? upd.path_prefix : (cur as { path_prefix?: string | null } | null)?.path_prefix ?? null;
    if (finalKind === 'sitemap' && !finalPrefix) throw new SourceError(400, 'VALIDATION_ERROR', 'a sitemap source needs a path_prefix');
  }
  if (input.scraper_id !== undefined) upd.scraper_id = scraperId(input.scraper_id);
  if (upd.status === 'active') {
    // The FeedScraper cannot run an html row (no extractor yet), so it never goes active.
    let finalKind = upd.kind as string | undefined;
    if (!finalKind) {
      const { data: cur } = await sb.from('discovery_sources').select('kind').eq('id', id).maybeSingle();
      finalKind = (cur as { kind?: string } | null)?.kind;
    }
    if (finalKind === 'html') throw new SourceError(400, 'VALIDATION_ERROR', 'an html source cannot be activated: give it a feed or sitemap first');
  }
  if (Object.keys(upd).length === 0) throw new SourceError(400, 'VALIDATION_ERROR', 'nothing to change');

  const { data, error } = await sb.from('discovery_sources').update(upd).eq('id', id).select(PUBLIC_SOURCE_FIELDS.join(',')).maybeSingle();
  if (error) {
    if (error.code === '23505') throw new SourceError(409, 'ALREADY_TRACKED', 'Another source already has that feed URL');
    throw new SourceError(500, 'QUERY_ERROR', error.message);
  }
  if (!data) throw new SourceError(404, 'NOT_FOUND', 'source not found');
  return data as unknown as Record<string, unknown>;
}

export interface ListInput { status?: unknown; foundation?: unknown; q?: unknown; limit: number; offset: number }

export async function list(sb: SupabaseClient, input: ListInput) {
  const status = oneOf(input.status, SOURCE_STATUSES, 'status');
  const foundation = text(input.foundation, 200, 'foundation');
  const q = text(input.q, 200, 'q');
  let query = sb
    .from('discovery_sources')
    .select(PUBLIC_SOURCE_FIELDS.join(','), { count: 'exact' })
    .order('foundation')
    .order('project');
  if (status) query = query.eq('status', status);
  if (foundation) query = query.ilike('foundation', foundation.replace(/[%_\\]/g, (c) => `\\${c}`));
  if (!q) {
    const { data, count, error } = await query.range(input.offset, input.offset + input.limit - 1);
    if (error) throw new SourceError(500, 'QUERY_ERROR', error.message);
    return { items: (data ?? []) as unknown as Record<string, unknown>[], total: count ?? 0 };
  }
  // Free-text search: the registry is a few hundred rows, so match in process
  // rather than build a PostgREST `.or()` filter from user input
  // (security-boundaries.md: never interpolate input into `.or()`).
  const { data, error } = await query.limit(2000);
  if (error) throw new SourceError(500, 'QUERY_ERROR', error.message);
  const needle = q.toLowerCase();
  const rows = ((data ?? []) as unknown as Record<string, unknown>[]).filter((r) =>
    [r.project, r.foundation, r.feed_url, r.site_url].some((v) => typeof v === 'string' && v.toLowerCase().includes(needle)),
  );
  return { items: rows.slice(input.offset, input.offset + input.limit), total: rows.length };
}

export async function get(sb: SupabaseClient, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new SourceError(400, 'VALIDATION_ERROR', 'invalid id');
  const { data, error } = await sb.from('discovery_sources').select(PUBLIC_SOURCE_FIELDS.join(',')).eq('id', id).maybeSingle();
  if (error) throw new SourceError(500, 'QUERY_ERROR', error.message);
  if (!data) throw new SourceError(404, 'NOT_FOUND', 'source not found');
  return data as unknown as Record<string, unknown>;
}

/**
 * Enqueue a FeedScraper run through the scrapers module's job pipeline.
 * `sourceIds` limits the run to those sources (any status except dead).
 * Returns the scrapers_jobs id. The caller provides the BullMQ `addJob`
 * (the scrapers module owns the queue name/prefix bridge).
 */
export async function enqueueRun(
  sb: SupabaseClient,
  addJob: (type: string, data: Record<string, unknown>) => Promise<{ id: string | number | undefined }>,
  opts: { sourceIds?: string[]; createdBy: string },
) {
  const { data: scraper, error } = await sb.from('scrapers').select('id, name, scraper_type, event_type').eq('scraper_type', 'FeedScraper').maybeSingle();
  if (error) throw new SourceError(500, 'QUERY_ERROR', error.message);
  if (!scraper) throw new SourceError(409, 'SCRAPER_MISSING', 'The "Discovery feeds" scraper row is missing; re-run the module migrations');
  const ids = (opts.sourceIds ?? []).filter((s) => /^[0-9a-f-]{36}$/i.test(s));
  const { data: jobs, error: jobErr } = await sb.rpc('scrapers_create_job', {
    scraper_ids: [scraper.id],
    created_by_user: opts.createdBy,
    ...(ids.length ? { p_metadata: { source_ids: ids } } : {}),
  });
  if (jobErr || !jobs?.length) throw new SourceError(500, 'QUERY_ERROR', jobErr?.message ?? 'could not create job');
  const jobId = (jobs as Array<{ job_id: number }>)[0].job_id;
  await addJob('scraper:run', {
    scraperJobId: jobId,
    scraperId: scraper.id,
    scraperName: scraper.name,
    scraperType: scraper.scraper_type,
    eventType: scraper.event_type,
    manual: true,
    // The handler reads per-job options from HERE (server-written), not from
    // scrapers_jobs.metadata, which any authenticated user can write.
    ...(ids.length ? { options: { source_ids: ids } } : {}),
  });
  return { job_id: jobId, scraper_id: scraper.id };
}
