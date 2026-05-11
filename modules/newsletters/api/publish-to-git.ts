/**
 * Edition publish-to-git — server-side renderer + commit pipeline. Per
 * spec-builder-evaluation §3.6 (extended).
 *
 * Mirrors sites' publish-worker pattern: take an edition, render via
 * `<EditionEmail/>` once, commit the output to the newsletter's
 * internal Git repo on the `publish` branch. Each newsletter's repo
 * accumulates one commit per edition publish; operators can graduate
 * the internal repo to an external GitHub remote at any time
 * (graduate-to-external, sites-shared infra).
 *
 * Lazy clone: if the newsletter doesn't yet have an internal repo
 * (no `gatewaze_internal_repos` row with host_kind='newsletter',
 * host_id=<newsletter_id>), the first publish creates it via
 * `gitServer.createRepo({ boilerplateUrl: NEWSLETTERS_BOILERPLATE_URL })`.
 *
 * The endpoint is deliberately tolerant of missing pieces: when the
 * boilerplate URL is unset OR the gitServer dep isn't wired in this
 * deployment, the route returns a 200 with `{ kind: 'skipped',
 * reason: ... }` so the editor's Publish flow degrades gracefully
 * to DB-only persistence (today's behaviour).
 */

import type { Router, Response, NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

// NOTE: This endpoint used to import EditionEmail + @react-email/render and
// render the HTML server-side. That pulled the admin's email-blocks barrel
// which transitively requires the field adapters (Puck, @heroicons/react,
// sonner, the admin's RichTextEditor via the `@/` alias) — none of which
// resolve in the API container. The editor already produces the rendered
// HTML via `exportEditionHtml` (the same path the Send and HTML-export
// buttons use), so the client now POSTs it in the request body. The
// endpoint just commits it to git.

interface RequestWithUser {
  userId?: string;
  params: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Minimal subset of sites' InternalGitServer interface — the only
 * methods this route calls. Imported lazily so the newsletters
 * module doesn't hard-depend on sites being installed; if absent,
 * the endpoint short-circuits to skipped-mode.
 */
interface MinimalGitServer {
  lookupRepo(hostKind: 'newsletter', hostId: string): Promise<{ id: string; barePath: string; defaultBranch: string } | null>;
  createRepo(args: {
    hostKind: 'newsletter';
    hostId: string;
    slug: string;
    boilerplateUrl?: string | null;
    boilerplateBranch?: string | null;
  }): Promise<{ id: string; barePath: string; defaultBranch: string }>;
  publishCommit(args: {
    repo: { id: string; barePath: string };
    branch: string;
    /**
     * Map of relative path → file contents. The impl iterates
     * via `for (const [path, contents] of args.files)`; an array
     * of `{path, content}` objects would silently destructure to
     * `undefined, undefined` and fail with "for is not iterable"
     * (the impl expects a Map per sites/lib/git/internal-git-server.ts).
     */
    files: Map<string, Buffer | string>;
    message: string;
    author: { name: string; email: string };
  }): Promise<{ sha: string; diffBytes: number; filesChanged: number }>;
}

export interface PublishToGitDeps {
  supabase: SupabaseClient;
  gitServer?: MinimalGitServer;
  /** Override env. Empty string / undefined → skipped. */
  boilerplateUrl?: string | null;
  boilerplateBranch?: string | null;
}

export function createPublishToGitRoute(deps: PublishToGitDeps) {
  return async function publishToGit(req: RequestWithUser, res: Response, _next: NextFunction): Promise<void> {
    if (!req.userId) {
      res.status(401).json({ error: { code: 'unauthenticated', message: 'session required' } });
      return;
    }
    const editionId = req.params.editionId;
    if (!editionId) {
      res.status(400).json({ error: { code: 'missing_edition_id' } });
      return;
    }

    if (!deps.gitServer) {
      res.status(200).json({ kind: 'skipped', reason: 'gitServer dependency not wired in this deployment' });
      return;
    }

    try {
      // 1. Load edition + blocks + parent newsletter.
      const editionRes = await deps.supabase
        .from('newsletters_editions')
        .select('id, title, edition_date, preheader, status, collection_id')
        .eq('id', editionId)
        .maybeSingle();
      if (editionRes.error || !editionRes.data) {
        // eslint-disable-next-line no-console
        console.warn('[newsletters publish-to-git] edition lookup failed', {
          editionId,
          supabaseError: editionRes.error?.message ?? null,
          supabaseDetails: editionRes.error?.details ?? null,
          hasData: !!editionRes.data,
        });
        res.status(404).json({
          error: {
            code: 'edition_not_found',
            // Surface the actual lookup parameters in the message so
            // the editor's toast tells the operator exactly which
            // edition the server couldn't find. Previously the
            // message was the bare supabase error (empty string when
            // .single() returned 0 rows), which read like a route-
            // not-found from the network tab.
            message: editionRes.error?.message
              ? `Edition lookup failed: ${editionRes.error.message} (editionId=${editionId})`
              : `No newsletters_editions row with id=${editionId}. Has the edition been saved to the database yet?`,
            editionId,
          },
        });
        return;
      }
      const ed = editionRes.data as {
        id: string; title: string | null; edition_date: string;
        preheader: string | null; status: string; collection_id: string | null;
      };

      // 2. Resolve the channel container — `newsletters_template_collections`
      //    holds the actual channel definition (name, slug, branding). The
      //    repo is keyed off this row's id, mirroring how sites use
      //    `sites.id` as the gatewaze_internal_repos.host_id.
      if (!ed.collection_id) {
        res.status(200).json({
          kind: 'skipped',
          reason: 'edition has no parent collection',
          editionId,
        });
        return;
      }
      const collRes = await deps.supabase
        .from('newsletters_template_collections')
        .select('id, slug, name, git_provenance, git_url, git_branch')
        .eq('id', ed.collection_id)
        .maybeSingle();
      if (collRes.error || !collRes.data) {
        res.status(200).json({
          kind: 'skipped',
          reason: 'collection lookup failed',
          editionId,
        });
        return;
      }
      const collection = collRes.data as {
        id: string;
        slug: string;
        name: string;
        git_provenance: 'internal' | 'external';
        git_url: string | null;
        git_branch: string | null;
      };
      const newsletterId = collection.id;
      const newsletterSlug = collection.slug;

      // Gate: only publish to git when the newsletter has graduated
      // to an EXTERNAL git repo. While git_provenance='internal' the
      // platform's lazy-cloned boilerplate is the only thing on the
      // PVC — committing edition output there pollutes the
      // gatewaze-template-email starting point and confuses the
      // graduate-to-external flow later. Return a 200/skipped so the
      // editor can surface a clear "no external repo connected"
      // warning instead of an opaque error.
      if (collection.git_provenance !== 'external' || !collection.git_url) {
        res.status(200).json({
          kind: 'skipped',
          reason: 'no_external_git_repo',
          message:
            'This newsletter is using the platform boilerplate template. ' +
            'Connect an external git repo (Settings → Git) before publishing — ' +
            'editions are still saved to the database.',
          editionId,
        });
        return;
      }

      // 3. Lookup or lazy-create the internal repo for the newsletter.
      let repo = await deps.gitServer.lookupRepo('newsletter', newsletterId);
      if (!repo) {
        if (!deps.boilerplateUrl) {
          res.status(200).json({
            kind: 'skipped',
            reason: 'NEWSLETTERS_BOILERPLATE_URL not set; edition saved to DB only',
          });
          return;
        }
        repo = await deps.gitServer.createRepo({
          hostKind: 'newsletter',
          hostId: newsletterId,
          slug: newsletterSlug,
          boilerplateUrl: deps.boilerplateUrl,
          boilerplateBranch: deps.boilerplateBranch ?? 'theme',
        });
      }

      // 4. Take the rendered HTML from the request body (produced
      //    client-side via exportEditionHtml — same path the editor's
      //    Send and HTML-export buttons use). We also still load the
      //    blocks so we can persist a content-stable JSON snapshot
      //    alongside the HTML; the join to templates_block_defs is
      //    only used to record render_kind / component_id on each
      //    block row in the JSON output, so external consumers know
      //    how the HTML was produced.
      const html = typeof req.body?.html === 'string' ? req.body.html : '';
      if (!html) {
        res.status(400).json({
          error: {
            code: 'missing_rendered_html',
            message:
              'publish-to-git requires the editor-rendered HTML in the request body (`html` field). ' +
              'The server no longer renders editions — exportEditionHtml runs client-side.',
          },
        });
        return;
      }

      const blocksRes = await deps.supabase
        .from('newsletters_edition_blocks')
        .select(`
          id, block_type, content, sort_order, templates_block_def_id,
          block_template:templates_block_defs!templates_block_def_id(id, html, render_kind, component_id)
        `)
        .eq('edition_id', editionId)
        .order('sort_order');
      if (blocksRes.error) {
        res.status(500).json({ error: { code: 'blocks_fetch_failed', message: blocksRes.error.message } });
        return;
      }
      const blockRows = (blocksRes.data ?? []) as Array<{
        id: string; block_type: string; content: Record<string, unknown>; sort_order: number;
        templates_block_def_id: string | null;
        block_template: { id: string; html: string | null; render_kind: 'mustache' | 'react-email'; component_id: string | null } | null;
      }>;

      // 6. Commit to the configured publish branch (collection.git_branch
      //    defaults to 'publish' per migration 027). The output files
      //    live at the repo root under `editions/`, NOT under a
      //    `published/` subfolder.
      const publishBranch = collection.git_branch || 'publish';
      // publishCommit expects a Map<path, contents>, not an array of
      // {path, content} objects — see the MinimalGitServer interface
      // above and the iteration in
      // modules/sites/lib/git/internal-git-server-impl.ts.
      const files = new Map<string, string>();
      files.set(`editions/${ed.id}.html`, html);
      files.set(`editions/${ed.id}.json`, JSON.stringify({
        id: ed.id,
        edition_date: ed.edition_date,
        subject: ed.title,
        preheader: ed.preheader,
        status: ed.status,
        blocks: blockRows.map((b) => ({
          id: b.id,
          block_type: b.block_type,
          content: b.content,
          sort_order: b.sort_order,
          render_kind: b.block_template?.render_kind ?? 'react-email',
          component_id: b.block_template?.component_id ?? b.block_type,
        })),
      }, null, 2));
      const result = await deps.gitServer.publishCommit({
        repo: { id: repo.id, barePath: repo.barePath },
        branch: publishBranch,
        files,
        message: `Publish edition ${ed.title ?? ed.edition_date}`,
        author: { name: 'gatewaze-publisher', email: 'noreply@gatewaze' },
      });

      res.status(200).json({
        kind: 'published',
        editionId: ed.id,
        repoId: repo.id,
        commitSha: result.sha,
        branch: publishBranch,
        files: [`editions/${ed.id}.html`, `editions/${ed.id}.json`],
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[newsletters publish-to-git] unexpected error', err);
      res.status(500).json({
        error: {
          code: 'publish_to_git_failed',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  };
}

export function mountPublishToGitRoute(
  router: Router,
  handler: ReturnType<typeof createPublishToGitRoute>,
): void {
  router.post('/newsletters/editions/:editionId/publish-to-git', handler as never);
}
