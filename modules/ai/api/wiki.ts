// @ts-nocheck — depends on express + supabase resolved at host install.

/**
 * Admin API for the AI wiki layer. spec-ai-memory-wiki.md §6.
 *
 *   GET    /admin/wiki/pages?use_case&prefix&category&where&limit
 *   GET    /admin/wiki/pages/:id
 *   POST   /admin/wiki/pages
 *   PUT    /admin/wiki/pages/:id
 *   DELETE /admin/wiki/pages/:id
 *   POST   /admin/wiki/pages/:id/resolve-conflict   { choice: 'winner'|'loser' }
 *   GET    /admin/wiki/search?use_case&q&k&mode&scope&kinds
 *   GET    /admin/wiki/sources?use_case&prefix&limit
 *   POST   /admin/wiki/sources
 *   GET    /admin/wiki/sync?use_case        PUT /admin/wiki/sync
 *   POST   /admin/wiki/sync/run             POST /admin/wiki/sync/pull
 *   GET    /admin/wiki/grants?use_case      PUT/DELETE /admin/wiki/grants
 *   POST   /wiki/webhook/git?use_case       (UNAUTHENTICATED — HMAC verified)
 *
 * Routes are thin glue over lib/wiki/repository (typechecked); embedding is
 * injected via deps.embed (aiEmbed in-process) — null ⇒ keyword-only + deferred
 * page embeds (spec §5.8 / §10 embed_deferred).
 */

import type { Router, Request, Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  upsertPage,
  readPage,
  listPages,
  softDeletePage,
  searchPages,
  readSource,
  listSources,
} from '../lib/wiki/repository.js';
import { contentHash } from '../lib/wiki/hash.js';

interface MountDeps {
  supabase: { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };
  embed?: ((texts: string[], useCase: string) => Promise<number[][]>) | null;
  enqueueJob?: (queue: string, name: string, data: Record<string, unknown>) => Promise<{ id: string }>;
  /** Service-role key the wiki MCP presents on /internal/wiki/* (service-to-service auth). */
  internalKey?: string | null;
  logger?: { warn: (m: string, f?: Record<string, unknown>) => void };
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function pick<T extends Record<string, unknown>>(body: unknown, fields: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  if (body && typeof body === 'object') {
    for (const f of fields) if (f in (body as Record<string, unknown>)) out[f] = (body as Record<string, unknown>)[f];
  }
  return out as Partial<T>;
}

const PAGE_CREATE_FIELDS = ['use_case', 'slug', 'title', 'body', 'summary', 'category', 'metadata'] as const;
const PAGE_UPDATE_FIELDS = ['title', 'body', 'summary', 'category', 'metadata'] as const;
const SOURCE_CREATE_FIELDS = ['use_case', 'slug', 'source_type', 'uri', 'title', 'content', 'metadata'] as const;
const SYNC_UPDATE_FIELDS = ['git_remote', 'git_branch', 'pull_enabled'] as const;

async function pageRefById(supabase: MountDeps['supabase'], id: string): Promise<{ use_case: string; slug: string } | null> {
  const r = await supabase.from('ai_wiki_page').select('use_case, slug').eq('id', id).maybeSingle();
  return r.error || !r.data ? null : (r.data as { use_case: string; slug: string });
}

export function mountWikiRoutes(router: Router, deps: MountDeps): void {
  const embed = deps.embed ?? null;

  // --- pages ---------------------------------------------------------------
  router.get('/admin/wiki/pages', async (req: Request, res: Response): Promise<void> => {
    const useCase = typeof req.query.use_case === 'string' ? req.query.use_case : undefined;
    if (!useCase) return sendError(res, 400, 'invalid_input', 'use_case required');
    let where: unknown;
    if (typeof req.query.where === 'string') {
      try { where = JSON.parse(req.query.where); } catch { return sendError(res, 400, 'invalid_input', 'where must be JSON'); }
    }
    const pages = await listPages(deps.supabase, useCase, {
      ...(typeof req.query.prefix === 'string' ? { prefix: req.query.prefix } : {}),
      ...(typeof req.query.category === 'string' ? { category: req.query.category } : {}),
      ...(where !== undefined ? { where } : {}),
      ...(typeof req.query.limit === 'string' ? { limit: Number(req.query.limit) } : {}),
    });
    res.status(200).json({ pages });
  });

  router.get('/admin/wiki/pages/:id', async (req: Request, res: Response): Promise<void> => {
    const ref = await pageRefById(deps.supabase, req.params.id);
    if (!ref) return sendError(res, 404, 'not_found', 'page not found');
    const page = await readPage(deps.supabase, ref.use_case, ref.slug);
    if (!page) return sendError(res, 404, 'not_found', 'page not found');
    const inbound = await deps.supabase
      .from('ai_wiki_link')
      .select('from_use_case, from_slug')
      .eq('to_use_case', ref.use_case)
      .eq('to_slug', ref.slug);
    res.status(200).json({ page, inbound: (inbound?.data as unknown[]) ?? [] });
  });

  router.post('/admin/wiki/pages', async (req: Request, res: Response): Promise<void> => {
    const f = pick(req.body, PAGE_CREATE_FIELDS);
    if (!f.use_case || !f.slug || typeof f.title !== 'string') return sendError(res, 400, 'invalid_input', 'use_case, slug, title required');
    // 409 if a live page already owns the slug.
    const existing = await readPage(deps.supabase, String(f.use_case), String(f.slug));
    if (existing) return sendError(res, 409, 'slug_exists', 'a live page already owns this slug');
    const r = await upsertPage(deps.supabase, {
      useCase: String(f.use_case), slug: String(f.slug), title: String(f.title), body: String(f.body ?? ''),
      summary: (f.summary as string) ?? null, category: (f.category as string) ?? null,
      metadata: (f.metadata as Record<string, unknown>) ?? {}, source: 'human',
      userId: (req as { userId?: string }).userId ?? null,
    }, embed);
    if (!r.ok) return sendError(res, r.error?.startsWith('invalid_slug') ? 400 : 500, r.error?.startsWith('invalid_slug') ? 'invalid_input' : 'internal_error', r.error ?? 'upsert failed');
    const page = await readPage(deps.supabase, String(f.use_case), String(f.slug));
    res.status(201).json({ page, ...(r.warning ? { warning: r.warning } : {}) });
  });

  router.put('/admin/wiki/pages/:id', async (req: Request, res: Response): Promise<void> => {
    const ref = await pageRefById(deps.supabase, req.params.id);
    if (!ref) return sendError(res, 404, 'not_found', 'page not found');
    const cur = await readPage(deps.supabase, ref.use_case, ref.slug);
    if (!cur) return sendError(res, 404, 'not_found', 'page not found');
    const f = pick(req.body, PAGE_UPDATE_FIELDS);
    const r = await upsertPage(deps.supabase, {
      useCase: ref.use_case, slug: ref.slug,
      title: (f.title as string) ?? String(cur.title),
      body: (f.body as string) ?? String(cur.body),
      summary: (f.summary as string) ?? (cur.summary as string) ?? null,
      category: (f.category as string) ?? (cur.category as string) ?? null,
      metadata: (f.metadata as Record<string, unknown>) ?? (cur.metadata as Record<string, unknown>) ?? {},
      source: 'human', userId: (req as { userId?: string }).userId ?? null,
    }, embed);
    if (!r.ok) return sendError(res, 500, 'internal_error', r.error ?? 'update failed');
    const page = await readPage(deps.supabase, ref.use_case, ref.slug);
    res.status(200).json({ page });
  });

  router.delete('/admin/wiki/pages/:id', async (req: Request, res: Response): Promise<void> => {
    const ref = await pageRefById(deps.supabase, req.params.id);
    if (!ref) return sendError(res, 404, 'not_found', 'page not found');
    const ok = await softDeletePage(deps.supabase, ref.use_case, ref.slug);
    if (!ok) return sendError(res, 500, 'internal_error', 'delete failed');
    res.status(204).send();
  });

  router.post('/admin/wiki/pages/:id/resolve-conflict', async (req: Request, res: Response): Promise<void> => {
    const ref = await pageRefById(deps.supabase, req.params.id);
    if (!ref) return sendError(res, 404, 'not_found', 'page not found');
    const choice = (req.body as { choice?: string })?.choice;
    if (choice !== 'winner' && choice !== 'loser') return sendError(res, 400, 'invalid_input', "choice must be 'winner' or 'loser'");
    const cur = await readPage(deps.supabase, ref.use_case, ref.slug);
    if (!cur) return sendError(res, 404, 'not_found', 'page not found');
    if (choice === 'loser' && cur.conflict_detail && typeof cur.conflict_detail === 'object') {
      const loser = (cur.conflict_detail as { loser_body?: string; loser_title?: string });
      await upsertPage(deps.supabase, {
        useCase: ref.use_case, slug: ref.slug,
        title: loser.loser_title ?? String(cur.title), body: loser.loser_body ?? String(cur.body),
        source: 'human', userId: (req as { userId?: string }).userId ?? null,
      }, embed);
    }
    await deps.supabase.from('ai_wiki_page').update({ conflict: false, conflict_detail: null }).eq('id', req.params.id);
    const page = await readPage(deps.supabase, ref.use_case, ref.slug);
    res.status(200).json({ page });
  });

  // --- search --------------------------------------------------------------
  router.get('/admin/wiki/search', async (req: Request, res: Response): Promise<void> => {
    const useCase = typeof req.query.use_case === 'string' ? req.query.use_case : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    if (!useCase || !q) return sendError(res, 400, 'invalid_input', 'use_case and q required');
    const results = await searchPages(deps.supabase, {
      useCase, query: q,
      ...(typeof req.query.k === 'string' ? { k: Number(req.query.k) } : {}),
      ...(typeof req.query.mode === 'string' ? { mode: req.query.mode as 'hybrid' | 'keyword' | 'semantic' } : {}),
      ...(typeof req.query.scope === 'string' ? { scope: req.query.scope as 'self' | 'granted' | 'all' } : {}),
      ...(typeof req.query.kinds === 'string' ? { kinds: req.query.kinds.split(',') } : {}),
    }, embed);
    res.status(200).json({ results });
  });

  // --- raw sources ---------------------------------------------------------
  router.get('/admin/wiki/sources', async (req: Request, res: Response): Promise<void> => {
    const useCase = typeof req.query.use_case === 'string' ? req.query.use_case : undefined;
    if (!useCase) return sendError(res, 400, 'invalid_input', 'use_case required');
    const sources = await listSources(deps.supabase, useCase, {
      ...(typeof req.query.prefix === 'string' ? { prefix: req.query.prefix } : {}),
      ...(typeof req.query.limit === 'string' ? { limit: Number(req.query.limit) } : {}),
    });
    res.status(200).json({ sources });
  });

  router.post('/admin/wiki/sources', async (req: Request, res: Response): Promise<void> => {
    const f = pick(req.body, SOURCE_CREATE_FIELDS);
    if (!f.use_case || !f.slug || !f.source_type || typeof f.content !== 'string') {
      return sendError(res, 400, 'invalid_input', 'use_case, slug, source_type, content required');
    }
    const row = {
      use_case: String(f.use_case), slug: String(f.slug), source_type: String(f.source_type),
      uri: (f.uri as string) ?? null, title: (f.title as string) ?? null, content: String(f.content),
      content_hash: contentHash(String(f.title ?? ''), String(f.content)),
      metadata: (f.metadata as Record<string, unknown>) ?? {},
      created_by: (req as { userId?: string }).userId ?? null,
    };
    const r = await deps.supabase.from('ai_wiki_raw_source').upsert(row, { onConflict: 'use_case,slug,content_hash' }).select('id, slug, source_type, uri, title, fetched_at').maybeSingle();
    if (r.error) return sendError(res, 500, 'internal_error', r.error.message);
    res.status(201).json({ source: r.data });
  });

  // --- sync config + triggers ----------------------------------------------
  router.get('/admin/wiki/sync', async (req: Request, res: Response): Promise<void> => {
    const useCase = typeof req.query.use_case === 'string' ? req.query.use_case : undefined;
    if (!useCase) return sendError(res, 400, 'invalid_input', 'use_case required');
    const r = await deps.supabase.from('ai_wiki_sync_state')
      .select('use_case, git_remote, git_branch, pull_enabled, last_commit_sha, last_pulled_sha, synced_seq, pending_seq, conflict_count, last_synced_at, last_error')
      .eq('use_case', useCase).maybeSingle();
    if (r.error) return sendError(res, 500, 'internal_error', r.error.message);
    res.status(200).json({ state: r.data ?? { use_case: useCase, git_remote: null } });
  });

  router.put('/admin/wiki/sync', async (req: Request, res: Response): Promise<void> => {
    const useCase = (req.body as { use_case?: string })?.use_case;
    if (!useCase) return sendError(res, 400, 'invalid_input', 'use_case required');
    const patch: Record<string, unknown> = { use_case: useCase, ...pick(req.body, SYNC_UPDATE_FIELDS) };
    // Rotate the webhook secret when (re)connecting a remote.
    if ('git_remote' in patch && patch.git_remote) patch.webhook_secret = randomBytes(24).toString('hex');
    const r = await deps.supabase.from('ai_wiki_sync_state').upsert(patch, { onConflict: 'use_case' })
      .select('use_case, git_remote, git_branch, pull_enabled, last_commit_sha, last_pulled_sha, synced_seq, pending_seq, conflict_count, last_synced_at, last_error').maybeSingle();
    if (r.error) return sendError(res, 500, 'internal_error', r.error.message);
    res.status(200).json({ state: r.data });
  });

  router.post('/admin/wiki/sync/run', async (req: Request, res: Response): Promise<void> => {
    const useCase = (req.body as { use_case?: string })?.use_case;
    if (!useCase) return sendError(res, 400, 'invalid_input', 'use_case required');
    if (deps.enqueueJob) await deps.enqueueJob('jobs', 'ai:wiki-push', { useCase }); // worker: phase 5
    res.status(202).json({ enqueued: true });
  });

  router.post('/admin/wiki/sync/pull', async (req: Request, res: Response): Promise<void> => {
    const useCase = (req.body as { use_case?: string })?.use_case;
    if (!useCase) return sendError(res, 400, 'invalid_input', 'use_case required');
    if (deps.enqueueJob) await deps.enqueueJob('jobs', 'ai:wiki-pull', { useCase }); // worker: phase 5
    res.status(202).json({ enqueued: true });
  });

  // --- grants --------------------------------------------------------------
  router.get('/admin/wiki/grants', async (req: Request, res: Response): Promise<void> => {
    const useCase = typeof req.query.use_case === 'string' ? req.query.use_case : undefined;
    if (!useCase) return sendError(res, 400, 'invalid_input', 'use_case required');
    const r = await deps.supabase.from('ai_wiki_grant').select('grantee_use_case, grantor_use_case, can_read, can_write, created_at').eq('grantee_use_case', useCase);
    if (r.error) return sendError(res, 500, 'internal_error', r.error.message);
    res.status(200).json({ grants: r.data ?? [] });
  });

  router.put('/admin/wiki/grants', async (req: Request, res: Response): Promise<void> => {
    const b = req.body as { grantee_use_case?: string; grantor_use_case?: string; can_read?: boolean; can_write?: boolean };
    if (!b?.grantee_use_case || !b?.grantor_use_case) return sendError(res, 400, 'invalid_input', 'grantee_use_case and grantor_use_case required');
    if (b.grantee_use_case === b.grantor_use_case) return sendError(res, 400, 'invalid_input', 'a use case implicitly grants itself');
    const row = {
      grantee_use_case: b.grantee_use_case, grantor_use_case: b.grantor_use_case,
      can_read: b.can_read ?? true, can_write: b.can_write ?? false,
      created_by: (req as { userId?: string }).userId ?? null,
    };
    const r = await deps.supabase.from('ai_wiki_grant').upsert(row, { onConflict: 'grantee_use_case,grantor_use_case' }).select('grantee_use_case, grantor_use_case, can_read, can_write, created_at').maybeSingle();
    if (r.error) return sendError(res, 500, 'internal_error', r.error.message);
    res.status(200).json({ grant: r.data });
  });

  router.delete('/admin/wiki/grants', async (req: Request, res: Response): Promise<void> => {
    const grantee = typeof req.query.grantee_use_case === 'string' ? req.query.grantee_use_case : undefined;
    const grantor = typeof req.query.grantor_use_case === 'string' ? req.query.grantor_use_case : undefined;
    if (!grantee || !grantor) return sendError(res, 400, 'invalid_input', 'grantee_use_case and grantor_use_case required');
    const r = await deps.supabase.from('ai_wiki_grant').delete().eq('grantee_use_case', grantee).eq('grantor_use_case', grantor);
    if (r.error) return sendError(res, 500, 'internal_error', r.error.message);
    res.status(204).send();
  });

  // --- git webhook (UNAUTHENTICATED; HMAC-verified) ------------------------
  router.post('/wiki/webhook/git', async (req: Request, res: Response): Promise<void> => {
    const useCase = typeof req.query.use_case === 'string' ? req.query.use_case : undefined;
    if (!useCase) return sendError(res, 400, 'invalid_input', 'use_case required');
    const st = await deps.supabase.from('ai_wiki_sync_state').select('webhook_secret, pull_enabled').eq('use_case', useCase).maybeSingle();
    const secret = (st?.data as { webhook_secret?: string } | null)?.webhook_secret;
    if (!secret) return sendError(res, 401, 'webhook_unverified', 'no webhook configured');
    // HMAC over the raw body (host must mount raw-body middleware for this route;
    // falls back to the parsed JSON string otherwise). spec §9.12.
    const raw = (req as { rawBody?: Buffer | string }).rawBody ?? JSON.stringify(req.body ?? {});
    const sig = String(req.headers['x-gatewaze-signature'] ?? req.headers['x-hub-signature-256'] ?? '').replace(/^sha256=/, '');
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    const a = Buffer.from(sig, 'hex'); const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return sendError(res, 401, 'webhook_unverified', 'bad signature');
    if ((st!.data as { pull_enabled?: boolean }).pull_enabled === false) return res.status(202).json({ enqueued: false });
    if (deps.enqueueJob) await deps.enqueueJob('jobs', 'ai:wiki-pull', { useCase }); // worker: phase 5
    res.status(202).json({ enqueued: true });
  });

  // --- internal (service-to-service) surface for the wiki MCP --------------
  // Not under /admin, so it isn't gated by the operator JWT; instead it is
  // authenticated by the service-role key the MCP already holds. This lets the
  // spawned MCP be a thin stdio→HTTP adapter while all logic (hash, links,
  // embedding, cost-tracking) stays here over the shared repository. spec §5.8.
  function internalAuth(req: Request, res: Response): boolean {
    const key = deps.internalKey;
    const presented = String(req.headers['x-gatewaze-internal-key'] ?? '');
    if (!key || presented.length !== key.length) { sendError(res, 401, 'unauthenticated', 'internal key required'); return false; }
    try {
      if (!timingSafeEqual(Buffer.from(presented), Buffer.from(key))) { sendError(res, 401, 'unauthenticated', 'bad internal key'); return false; }
    } catch { sendError(res, 401, 'unauthenticated', 'bad internal key'); return false; }
    return true;
  }

  router.get('/internal/wiki/search', async (req: Request, res: Response): Promise<void> => {
    if (!internalAuth(req, res)) return;
    const useCase = String(req.query.use_case ?? ''); const q = String(req.query.q ?? '');
    if (!useCase || !q) return sendError(res, 400, 'invalid_input', 'use_case and q required');
    const results = await searchPages(deps.supabase, {
      useCase, query: q,
      ...(req.query.k ? { k: Number(req.query.k) } : {}),
      ...(req.query.mode ? { mode: req.query.mode as any } : {}),
      ...(req.query.scope ? { scope: req.query.scope as any } : {}),
      ...(typeof req.query.kinds === 'string' ? { kinds: req.query.kinds.split(',') } : {}),
    }, embed);
    res.status(200).json({ results });
  });

  router.get('/internal/wiki/read', async (req: Request, res: Response): Promise<void> => {
    if (!internalAuth(req, res)) return;
    const useCase = String(req.query.use_case ?? ''); const slug = String(req.query.slug ?? '');
    if (!useCase || !slug) return sendError(res, 400, 'invalid_input', 'use_case and slug required');
    const page = await readPage(deps.supabase, useCase, slug);
    res.status(200).json({ found: !!page, ...(page ? { page } : {}) });
  });

  router.get('/internal/wiki/list', async (req: Request, res: Response): Promise<void> => {
    if (!internalAuth(req, res)) return;
    const useCase = String(req.query.use_case ?? '');
    if (!useCase) return sendError(res, 400, 'invalid_input', 'use_case required');
    let where: unknown;
    if (typeof req.query.where === 'string') { try { where = JSON.parse(req.query.where); } catch { /* ignore */ } }
    const pages = await listPages(deps.supabase, useCase, {
      ...(typeof req.query.prefix === 'string' ? { prefix: req.query.prefix } : {}),
      ...(typeof req.query.category === 'string' ? { category: req.query.category } : {}),
      ...(where !== undefined ? { where } : {}),
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
    });
    res.status(200).json({ pages });
  });

  router.post('/internal/wiki/upsert', async (req: Request, res: Response): Promise<void> => {
    if (!internalAuth(req, res)) return;
    const b = req.body as { use_case?: string; slug?: string; title?: string; body?: string; summary?: string; category?: string; metadata?: Record<string, unknown>; message_id?: string };
    if (!b?.use_case || !b?.slug || typeof b.title !== 'string') return sendError(res, 400, 'invalid_input', 'use_case, slug, title required');
    const r = await upsertPage(deps.supabase, {
      useCase: b.use_case, slug: b.slug, title: b.title, body: String(b.body ?? ''),
      summary: b.summary ?? null, category: b.category ?? null, metadata: b.metadata ?? {},
      source: 'model', messageId: b.message_id ?? null,
    }, embed);
    if (!r.ok) return sendError(res, r.error?.startsWith('invalid_slug') ? 400 : 500, r.error?.startsWith('invalid_slug') ? 'invalid_input' : 'internal_error', r.error ?? 'upsert failed');
    res.status(200).json({ ok: true, slug: r.slug, version: r.version, ...(r.warning ? { warning: r.warning } : {}) });
  });

  router.get('/internal/wiki/source', async (req: Request, res: Response): Promise<void> => {
    if (!internalAuth(req, res)) return;
    const useCase = String(req.query.use_case ?? ''); const slug = String(req.query.slug ?? '');
    if (!useCase || !slug) return sendError(res, 400, 'invalid_input', 'use_case and slug required');
    const source = await readSource(deps.supabase, useCase, slug);
    res.status(200).json({ found: !!source, ...(source ? { source } : {}) });
  });

  router.get('/internal/wiki/sources', async (req: Request, res: Response): Promise<void> => {
    if (!internalAuth(req, res)) return;
    const useCase = String(req.query.use_case ?? '');
    if (!useCase) return sendError(res, 400, 'invalid_input', 'use_case required');
    const sources = await listSources(deps.supabase, useCase, {
      ...(typeof req.query.prefix === 'string' ? { prefix: req.query.prefix } : {}),
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
    });
    res.status(200).json({ sources });
  });
}
