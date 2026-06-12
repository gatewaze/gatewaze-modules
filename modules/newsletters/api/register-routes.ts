// @ts-nocheck — module workspace isn't linked into the platform's
//                node_modules at typecheck time. Routes are exercised
//                via runtime tests + the live editor.
/**
 * Newsletters module — apiRoutes hook entry point. Mirrors
 * `modules/host-media/api/register-routes.ts`:
 *
 *   - Builds its own service-role supabase client from env vars
 *     (the api server's runtime context exposes `supabase: null`;
 *     it doesn't pass a pre-built client through `context.deps`,
 *     and an earlier draft of this hook silently no-op'd because
 *     it expected one).
 *   - Mounts an Express Router under `/api/admin` with our local
 *     `requireJwt()` upstream so each handler sees `req.userId`.
 *   - Wires the publish-to-git, init-repo, graduate-to-external,
 *     drift, manifest, and delete-collection routes.
 *
 * Optional gitServer: the sites module owns the InternalGitServer
 * implementation. We resolve it on-demand via dynamic import; if
 * sites isn't installed (or the impl path moves), we surface a
 * clear "git server unavailable" 5xx from the handlers themselves
 * rather than crashing here.
 */

import type { ModuleContext } from '@gatewaze/shared';
import { createClient } from '@supabase/supabase-js';
import { Router, type Express, type Request, type Response, type NextFunction } from 'express';

import { requireJwt } from '../lib/require-jwt.js';

export async function registerRoutes(app: Express, context?: ModuleContext): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !supabaseServiceKey) {
    // eslint-disable-next-line no-console
    console.warn('[newsletters] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping route registration');
    return;
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve the optional git server from the sites module. The impl
  // exposes a singleton accessor at `lib/git/internal-git-server-impl`
  // that lazily provisions on first use. Failures here are
  // non-fatal — the routes themselves return a typed error response
  // if a git operation is requested without the impl.
  let gitServer: unknown = null;
  try {
    const mod = await import('../../sites/lib/git/internal-git-server-impl.js');
    const factory = (mod as { getInternalGitServer?: () => unknown; default?: { getInternalGitServer?: () => unknown } });
    const get = factory.getInternalGitServer ?? factory.default?.getInternalGitServer;
    if (typeof get === 'function') {
      gitServer = get();
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[newsletters] internal git server unavailable; git routes will return 503 if invoked:', (err as Error).message);
  }

  const {
    createPublishToGitRoute,
    createInitRepoRoute,
    createGraduateToExternalRoute,
    createDriftRoute,
    createManifestRoute,
    createDeleteCollectionRoute,
  } = await import('./index.js');

  // Resolve the boilerplate URL + branch via the central templates helper
  // so a single env-var pair (GATEWAZE_NEWSLETTER_BOILERPLATE_URL /
  // GATEWAZE_NEWSLETTER_BOILERPLATE_BRANCH) governs every newsletter
  // boilerplate consumer. Unset env → canonical defaults
  // (github.com/gatewaze/gatewaze-template-email, branch `theme`).
  const { getBoilerplateConfig } = await import('../../templates/lib/boilerplate/index.js');
  const boilerplate = getBoilerplateConfig('newsletter');

  const baseDeps = {
    supabase,
    ...(gitServer ? { gitServer } : {}),
    boilerplateUrl: boilerplate.url,
    boilerplateBranch: boilerplate.branch,
  } as never;

  const publishHandler = createPublishToGitRoute(baseDeps);
  const initRepoHandler = createInitRepoRoute(baseDeps);
  const graduateHandler = createGraduateToExternalRoute(baseDeps);
  const driftHandler = createDriftRoute(baseDeps);
  const manifestHandler = createManifestRoute(baseDeps);
  const deleteCollectionHandler = createDeleteCollectionRoute({
    supabase,
    ...(gitServer ? { gitServer } : {}),
  } as never);

  // Each handler uses async/await but Express 4 doesn't propagate
  // rejections automatically. Wrap them so unhandled errors land in
  // the express error pipeline (5xx) rather than hanging the request.
  const wrap = (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        await fn(req, res, next);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[newsletters] route handler threw:', err);
        if (!res.headersSent) {
          res.status(500).json({
            error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    };

  const router = Router();
  router.use(requireJwt());

  router.post('/newsletters/editions/:editionId/publish-to-git', wrap(publishHandler));
  router.post('/newsletters/collections/:collectionId/init-repo', wrap(initRepoHandler));
  router.post('/newsletters/collections/:collectionId/graduate-to-external', wrap(graduateHandler));
  router.get('/newsletters/collections/:collectionId/drift', wrap(driftHandler));
  router.get('/newsletters/collections/:collectionId/manifest', wrap(manifestHandler));
  router.delete('/newsletters/collections/:collectionId', wrap(deleteCollectionHandler));

  // POST /api/admin/newsletters/collections/:collectionId/sync-template-config
  //
  // Pull wrapper.json (the fixed header/footer link set) from the template
  // git repo's branch into collection.config.wrapper, using the templates git
  // source's stored PAT. The render path (EditionEmail) reads this to draw the
  // fixed header/footer chrome around every edition.
  router.post(
    '/newsletters/collections/:collectionId/sync-template-config',
    wrap(async (req: Request, res: Response) => {
      const collectionId = req.params['collectionId'];
      if (!collectionId) {
        res.status(400).json({ error: { code: 'validation_failed', message: 'collectionId required' } });
        return;
      }

      const { data: coll } = await supabase
        .from('newsletters_template_collections')
        .select('id, git_url, config')
        .eq('id', collectionId)
        .maybeSingle();
      if (!coll?.git_url) {
        res.status(400).json({ error: { code: 'no_git_repo', message: 'Newsletter has no connected git repo' } });
        return;
      }

      const { data: src } = await supabase
        .from('templates_sources')
        .select('token_secret_ref, branch')
        .eq('library_id', collectionId)
        .eq('kind', 'git')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const rawToken = (src as { token_secret_ref: string | null } | null)?.token_secret_ref ?? null;
      const token = rawToken && rawToken !== '<redacted>' ? rawToken : null;
      const branch = (src as { branch: string | null } | null)?.branch || 'main';

      const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(coll.git_url);
      if (!m) {
        res.status(400).json({ error: { code: 'unsupported_repo', message: 'Only github.com repos support config sync' } });
        return;
      }
      const [, owner, repo] = m;

      const ghRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/wrapper.json?ref=${encodeURIComponent(branch)}`,
        {
          headers: {
            Accept: 'application/vnd.github.raw+json',
            'User-Agent': 'gatewaze-newsletters',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );
      if (ghRes.status === 404) {
        res.status(404).json({ error: { code: 'no_wrapper_json', message: 'wrapper.json not found on the template repo' } });
        return;
      }
      if (!ghRes.ok) {
        res.status(502).json({ error: { code: 'github_error', message: `GitHub returned ${ghRes.status}` } });
        return;
      }

      let wrapper: unknown;
      try {
        wrapper = JSON.parse(await ghRes.text());
      } catch {
        res.status(422).json({ error: { code: 'invalid_json', message: 'wrapper.json is not valid JSON' } });
        return;
      }
      if (!wrapper || typeof wrapper !== 'object') {
        res.status(422).json({ error: { code: 'invalid_shape', message: 'wrapper.json must be a JSON object' } });
        return;
      }

      const config = { ...(((coll.config as Record<string, unknown>) ?? {})), wrapper };
      const { error: upErr } = await supabase
        .from('newsletters_template_collections')
        .update({ config })
        .eq('id', collectionId);
      if (upErr) {
        res.status(500).json({ error: { code: 'update_failed', message: upErr.message } });
        return;
      }

      res.status(200).json({ ok: true, wrapper });
    }),
  );

  // POST /api/admin/newsletters/collections/:collectionId/sync-declarative-blocks
  //
  // Read the template repo's `blocks/` directory (declarative html-ish block
  // sources) and upsert each as a render_kind='declarative' block def in this
  // newsletter's library, so git-authored blocks drive the editor + render.
  router.post(
    '/newsletters/collections/:collectionId/sync-declarative-blocks',
    wrap(async (req: Request, res: Response) => {
      const collectionId = req.params['collectionId'];
      if (!collectionId) {
        res.status(400).json({ error: { code: 'validation_failed', message: 'collectionId required' } });
        return;
      }

      const { data: coll } = await supabase
        .from('newsletters_template_collections')
        .select('id, git_url')
        .eq('id', collectionId)
        .maybeSingle();
      if (!coll?.git_url) {
        res.status(400).json({ error: { code: 'no_git_repo', message: 'Newsletter has no connected git repo' } });
        return;
      }

      const { data: src } = await supabase
        .from('templates_sources')
        .select('token_secret_ref, branch')
        .eq('library_id', collectionId)
        .eq('kind', 'git')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const rawToken = (src as { token_secret_ref: string | null } | null)?.token_secret_ref ?? null;
      const token = rawToken && rawToken !== '<redacted>' ? rawToken : null;
      const branch = (src as { branch: string | null } | null)?.branch || 'main';

      const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(coll.git_url);
      if (!m) {
        res.status(400).json({ error: { code: 'unsupported_repo', message: 'Only github.com repos supported' } });
        return;
      }
      const [, owner, repo] = m;
      const gh = (path: string, raw: boolean): Promise<Response> =>
        // eslint-disable-next-line no-undef
        fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, {
          headers: {
            Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
            'User-Agent': 'gatewaze-newsletters',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        }) as unknown as Promise<Response>;

      const listRes = await gh('blocks', false);
      if (listRes.status === 404) {
        res.status(200).json({ ok: true, synced: 0, message: 'no blocks/ directory in the template repo' });
        return;
      }
      if (!listRes.ok) {
        res.status(502).json({ error: { code: 'github_error', message: `GitHub returned ${listRes.status}` } });
        return;
      }
      const listing = (await listRes.json().catch(() => null)) as Array<{ name: string; type: string }> | null;
      const files = (listing ?? []).filter((f) => f.type === 'file' && /\.html?$/i.test(f.name));

      const titleCase = (k: string): string => k.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      let synced = 0;
      for (const f of files) {
        const fileRes = await gh(`blocks/${encodeURIComponent(f.name)}`, true);
        if (!fileRes.ok) continue;
        const source = await fileRes.text();
        const key = f.name.replace(/\.html?$/i, '');
        const schemaMatch = source.match(/<!--\s*SCHEMA:\s*([\s\S]*?)-->/i);
        let schema: unknown = {};
        if (schemaMatch) {
          try {
            schema = JSON.parse(schemaMatch[1].trim());
          } catch {
            schema = {};
          }
        }

        const { data: existing } = await supabase
          .from('templates_block_defs')
          .select('id')
          .eq('library_id', collectionId)
          .eq('key', key)
          .maybeSingle();
        if (existing?.id) {
          await supabase
            .from('templates_block_defs')
            .update({ name: titleCase(key), schema, html: source, render_kind: 'declarative', component_id: key })
            .eq('id', existing.id);
        } else {
          await supabase.from('templates_block_defs').insert({
            library_id: collectionId,
            key,
            name: titleCase(key),
            description: '',
            schema,
            html: source,
            has_bricks: false,
            render_kind: 'declarative',
            component_id: key,
          });
        }
        synced++;
      }

      res.status(200).json({ ok: true, synced });
    }),
  );

  // POST /api/admin/newsletters/editions/:editionId/test-send
  //
  // One-off send of the rendered HTML to a single email. Used by the
  // edition editor's "Test Send" toolbar — the operator gets the email
  // in their own inbox to sanity-check formatting against the real
  // Gmail / Outlook / Apple Mail rendering before scheduling the
  // actual send. Body shape mirrors the legacy
  // `functions/v1/send-email` call gatewaze-admin used:
  //   { recipient_email, html, subject, from_email?, from_name? }
  // — except the html is rendered by the client and posted up, rather
  // than re-rendered server-side, so this endpoint stays a thin
  // SendGrid wrapper (no DB read, no template plumbing). The subject
  // is prefixed with "[TEST] " so the recipient never confuses a
  // preview with a real edition.
  router.post('/newsletters/editions/:editionId/test-send', wrap(async (req, res) => {
    const editionId = req.params.editionId;
    const { recipient_email, html, subject, from_email, from_name } = (req.body ?? {}) as Record<string, string | undefined>;
    if (!recipient_email || !recipient_email.includes('@')) {
      res.status(400).json({ error: { code: 'invalid_recipient', message: 'recipient_email must be a valid email address' } });
      return;
    }
    if (!html || typeof html !== 'string' || html.length < 16) {
      res.status(400).json({ error: { code: 'invalid_html', message: 'html is required' } });
      return;
    }
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: { code: 'sendgrid_not_configured', message: 'SENDGRID_API_KEY is not set on the api process' } });
      return;
    }
    // Resolve the From identity. Prefer client-supplied values (so the
    // operator can preview "what the recipient will actually see"),
    // then fall back to the edition's collection, then the platform
    // EMAIL_FROM env var. SendGrid requires the From address to be
    // verified in the SendGrid account; mismatches return a 403 which
    // we surface verbatim.
    let resolvedFrom = from_email && from_email.includes('@') ? from_email : null;
    let resolvedFromName = from_name && from_name.trim() ? from_name.trim() : null;
    if (!resolvedFrom) {
      const { data: edition } = await supabase
        .from('newsletters_editions')
        .select('collection_id')
        .eq('id', editionId)
        .maybeSingle();
      if (edition?.collection_id) {
        const { data: col } = await supabase
          .from('newsletters_template_collections')
          .select('from_email, from_name')
          .eq('id', edition.collection_id)
          .maybeSingle();
        if (col?.from_email) resolvedFrom = col.from_email;
        if (!resolvedFromName && col?.from_name) resolvedFromName = col.from_name;
      }
    }
    if (!resolvedFrom) resolvedFrom = process.env.EMAIL_FROM ?? null;
    if (!resolvedFrom) {
      res.status(400).json({ error: { code: 'no_from_address', message: 'No verified from address configured on the newsletter or platform' } });
      return;
    }
    const finalSubject = `[TEST] ${(subject && subject.trim()) || 'Newsletter preview'}`;
    try {
      const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: recipient_email }] }],
          from: { email: resolvedFrom, ...(resolvedFromName ? { name: resolvedFromName } : {}) },
          subject: finalSubject,
          content: [{ type: 'text/html', value: html }],
        }),
      });
      if (!sgRes.ok) {
        const errText = await sgRes.text();
        res.status(sgRes.status).json({
          error: { code: 'sendgrid_error', message: `SendGrid ${sgRes.status}: ${errText.slice(0, 500)}` },
        });
        return;
      }
      res.json({ success: true, recipient: recipient_email, from: resolvedFrom });
    } catch (err) {
      res.status(502).json({
        error: { code: 'sendgrid_unreachable', message: err instanceof Error ? err.message : String(err) },
      });
    }
  }));

  // Admin guard for reporting. requireJwt sets req.userId; the service-role
  // client bypasses RLS, so we verify admin explicitly here.
  const requireAdmin = async (req: Request, res: Response): Promise<boolean> => {
    const userId = (req as Request & { userId?: string }).userId;
    if (!userId) {
      res.status(401).json({ error: { code: 'unauthenticated', message: 'No session' } });
      return false;
    }
    const { data } = await supabase
      .from('admin_profiles')
      .select('role, is_active')
      .eq('user_id', userId)
      .maybeSingle();
    const ok = !!data && data.is_active && ['super_admin', 'admin', 'editor'].includes(data.role);
    if (!ok) {
      res.status(403).json({ error: { code: 'forbidden', message: 'Admin access required' } });
      return false;
    }
    return true;
  };

  // GET /api/admin/newsletters/reports/block-engagement
  // Block-level click rollup. See spec-newsletter-link-tracking.md §6.1.
  router.get('/newsletters/reports/block-engagement', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const q = req.query as Record<string, string | undefined>;
    const { from, to } = q;
    if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      res.status(400).json({ error: { code: 'invalid_range', message: 'from and to (ISO-8601) are required' } });
      return;
    }
    const groupBy = q.group_by ?? 'block_type';
    if (!['block_type', 'slug', 'edition', 'persona'].includes(groupBy)) {
      res.status(400).json({ error: { code: 'invalid_group_by', message: 'group_by must be block_type|slug|edition|persona' } });
      return;
    }
    const includeBots = q.include_bots === 'true';

    // Tracked clicks in scope (edition_link_id resolved = tracked link).
    let iq = supabase
      .from('email_interactions')
      .select('email_send_log_id, edition_link_id, block_id, block_type, edition_id, personalization_consent, is_bot')
      .eq('event_type', 'click')
      .not('edition_link_id', 'is', null)
      .gte('event_timestamp', from)
      .lte('event_timestamp', to);
    if (q.edition_id) iq = iq.eq('edition_id', q.edition_id);
    if (q.block_type) iq = iq.eq('block_type', q.block_type);
    const { data: clicks, error: iErr } = await iq.limit(200000);
    if (iErr) {
      res.status(500).json({ error: { code: 'query_failed', message: iErr.message } });
      return;
    }
    const rows = (clicks ?? []) as Array<{
      email_send_log_id: string; edition_link_id: string; block_id: string | null;
      block_type: string | null; edition_id: string | null; personalization_consent: boolean; is_bot: boolean;
    }>;

    // Optional dimension lookups.
    const linkIds = [...new Set(rows.map((r) => r.edition_link_id))];
    const slugByLink = new Map<string, string | null>();
    if (groupBy === 'slug' && linkIds.length) {
      const { data: links } = await supabase
        .from('newsletters_edition_links')
        .select('id, tracking_slug, block_type')
        .in('id', linkIds);
      for (const l of (links ?? []) as Array<{ id: string; tracking_slug: string | null; block_type: string }>) {
        slugByLink.set(l.id, l.tracking_slug ?? l.block_type);
      }
    }
    const personaByLog = new Map<string, string>();
    if (groupBy === 'persona') {
      const logIds = [...new Set(rows.filter((r) => r.personalization_consent).map((r) => r.email_send_log_id))];
      const emailByLog = new Map<string, string>();
      for (let i = 0; i < logIds.length; i += 500) {
        const { data: logs } = await supabase
          .from('email_send_log').select('id, recipient_email').in('id', logIds.slice(i, i + 500));
        for (const l of (logs ?? []) as Array<{ id: string; recipient_email: string }>) emailByLog.set(l.id, l.recipient_email);
      }
      const emails = [...new Set([...emailByLog.values()])];
      const personaByEmail = new Map<string, string>();
      for (let i = 0; i < emails.length; i += 500) {
        const { data: ppl } = await supabase
          .from('people').select('email, attributes').in('email', emails.slice(i, i + 500));
        for (const p of (ppl ?? []) as Array<{ email: string; attributes: Record<string, unknown> | null }>) {
          const a = p.attributes ?? {};
          const persona = (a.job_title ?? a.persona ?? a.segment ?? 'unknown') as string;
          personaByEmail.set(p.email, String(persona) || 'unknown');
        }
      }
      for (const [logId, email] of emailByLog) personaByLog.set(logId, personaByEmail.get(email) ?? 'unknown');
    }

    // sent_count for CTR (per edition in scope).
    const editionIds = [...new Set(rows.map((r) => r.edition_id).filter(Boolean))] as string[];
    let totalSent = 0;
    if (editionIds.length) {
      const { data: sends } = await supabase
        .from('newsletter_sends').select('edition_id, sent_count').in('edition_id', editionIds);
      for (const s of (sends ?? []) as Array<{ sent_count: number | null }>) totalSent += s.sent_count ?? 0;
    }

    // Aggregate.
    interface Agg { key: string; edition_id: string | null; raw: number; humanPairs: Set<string>; recipients: Set<string>; }
    const groups = new Map<string, Agg>();
    for (const r of rows) {
      let key: string;
      if (groupBy === 'edition') key = r.edition_id ?? 'unknown';
      else if (groupBy === 'slug') key = slugByLink.get(r.edition_link_id) ?? r.block_type ?? 'unknown';
      else if (groupBy === 'persona') {
        if (!r.personalization_consent) continue; // opt-in: only attribute consented users
        key = personaByLog.get(r.email_send_log_id) ?? 'unknown';
      } else key = r.block_type ?? 'unknown';

      let g = groups.get(key);
      if (!g) { g = { key, edition_id: q.edition_id ?? (groupBy === 'edition' ? r.edition_id : null), raw: 0, humanPairs: new Set(), recipients: new Set() }; groups.set(key, g); }
      if (includeBots || !r.is_bot) g.raw++;
      if (!r.is_bot) {
        g.humanPairs.add(`${r.email_send_log_id}|${r.edition_link_id}`);
        g.recipients.add(r.email_send_log_id); // aggregate distinct-clicker count (no individual attribution)
      }
    }

    const out = [...groups.values()].map((g) => {
      const clicksN = g.humanPairs.size;
      return {
        block_type: groupBy === 'block_type' ? g.key : null,
        tracking_slug: groupBy === 'slug' ? g.key : null,
        edition_id: groupBy === 'edition' ? g.key : (q.edition_id ?? null),
        persona: groupBy === 'persona' ? g.key : null,
        clicks: clicksN,
        raw_clicks: g.raw,
        recipients: g.recipients.size,
        sent: totalSent,
        ctr: totalSent > 0 ? Number((clicksN / totalSent).toFixed(4)) : null,
      };
    }).sort((a, b) => b.clicks - a.clicks);

    res.json({ group_by: groupBy, from, to, rows: out });
  }));

  // Mount under /api/admin so the URL ends up at
  //   /api/admin/newsletters/editions/:editionId/publish-to-git etc.
  app.use('/api/admin', router);

  void context;
  // eslint-disable-next-line no-console
  console.log('[newsletters] routes registered (publish-to-git, init-repo, graduate, drift, manifest, delete-collection, test-send)');
}
