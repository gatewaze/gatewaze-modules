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
import { render } from '@react-email/render';
import { EditionEmail, type BlockRenderMeta } from '../admin/components/puck/email-blocks/EditionEmail.js';

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
    files: Array<{ path: string; content: string }>;
    message: string;
    author: { name: string; email: string };
  }): Promise<{ commitSha: string }>;
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
        .single();
      if (editionRes.error || !editionRes.data) {
        res.status(404).json({ error: { code: 'edition_not_found', message: editionRes.error?.message ?? '' } });
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
        .select('id, slug, name')
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
      const collection = collRes.data as { id: string; slug: string; name: string };
      const newsletterId = collection.id;
      const newsletterSlug = collection.slug;

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
          boilerplateBranch: deps.boilerplateBranch ?? 'main',
        });
      }

      // 4. Load blocks + per-block render metadata (render_kind +
      //    component_id from templates_block_defs).
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

      const blockMeta = new Map<string, BlockRenderMeta>();
      const editionBlocks = blockRows.map((row) => {
        const tpl = row.block_template;
        // Per spec §3.6 (extended). Rows where the joined template has
        // render_kind='react-email' route through the registry. Rows
        // without a template (legacy / registry-only) fall back to
        // detecting the registry by block_type. Otherwise Mustache.
        let meta: BlockRenderMeta;
        if (tpl?.render_kind === 'react-email' && tpl.component_id) {
          meta = { render_kind: 'react-email', component_id: tpl.component_id };
        } else if (!tpl) {
          // No joined template — registry block saved with NULL
          // templates_block_def_id (the editor side does this for
          // platform-default registry components).
          meta = { render_kind: 'react-email', component_id: row.block_type };
        } else {
          meta = { render_kind: 'mustache', mustache_html: tpl.html ?? '' };
        }
        blockMeta.set(row.id, meta);
        return {
          id: row.id,
          block_template: {
            id: tpl?.id ?? '',
            name: row.block_type,
            block_type: row.block_type,
            content: { html_template: tpl?.html ?? '' },
          },
          content: row.content ?? {},
          sort_order: row.sort_order,
          bricks: [],
        };
      });

      const editionView = {
        id: ed.id,
        edition_date: ed.edition_date,
        ...(ed.title ? { subject: ed.title } : {}),
        ...(ed.preheader ? { preheader: ed.preheader } : {}),
        blocks: editionBlocks,
      };

      // 5. Render once via EditionEmail.
      const html = await render(
        EditionEmail({ edition: editionView as never, format: 'email', blockMeta }),
        { pretty: false },
      );

      // 6. Commit to publish branch.
      const result = await deps.gitServer.publishCommit({
        repo: { id: repo.id, barePath: repo.barePath },
        branch: 'publish',
        files: [
          { path: `editions/${ed.id}.html`, content: html },
          { path: `editions/${ed.id}.json`, content: JSON.stringify({
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
          }, null, 2) },
        ],
        message: `Publish edition ${ed.title ?? ed.edition_date}`,
        author: { name: 'gatewaze-publisher', email: 'noreply@gatewaze' },
      });

      res.status(200).json({
        kind: 'published',
        editionId: ed.id,
        repoId: repo.id,
        commitSha: result.commitSha,
        branch: 'publish',
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
