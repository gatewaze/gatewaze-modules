/**
 * MCP tools exposed by the sites module.
 *
 * Per spec-content-modules-git-architecture §22.7. Surfaced when the MCP
 * server module is installed. Admin-scoped only — per-user MCP authorization
 * is v1.x.
 *
 * Tools:
 *   gatewaze.republish(site_slug, options?) -> { publishId, tag }
 *   gatewaze.send_edition(list_slug, edition_id, options?) -> { editionId, tag }
 *   gatewaze.get_site_status(site_slug) -> { status, git_url, last_publish_at, in_flight_publishes }
 *   gatewaze.list_sites() -> [{ slug, name, status, ... }]
 */

import type { RepublishSupabaseClient } from './republish.js';

export interface McpToolDeps {
  supabase: RepublishSupabaseClient;
  publishWorker: {
    enqueueRepublish(args: {
      siteId: string;
      triggerKind: 'mcp';
      triggeredBy: string;
      reason?: string;
      pages?: string[];
      force?: boolean;
    }): Promise<{ publishId: string; status: 'pending' }>;
  };
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: { adminId: string }) => Promise<unknown>;
}

export function createSitesMcpTools(deps: McpToolDeps): McpToolDef[] {
  return [
    {
      name: 'gatewaze.republish',
      description:
        'Trigger a republish of a site. Re-runs build-time fetchers (gatewaze-internal, ai-generated before-publish, external-fetched), regenerates static output, commits to publish branch, tags the release.',
      inputSchema: {
        type: 'object',
        required: ['site_slug'],
        properties: {
          site_slug: { type: 'string', description: 'Site slug (e.g. "marketing").' },
          reason: { type: 'string', description: 'Included in commit message + audit log.' },
          force: { type: 'boolean', description: 'Republish even if no content changed (skip no-diff optimization).' },
          pages: {
            type: 'array',
            items: { type: 'string' },
            description: 'Subset of page slugs to republish (else all pages).',
          },
        },
      },
      handler: async (args, ctx) => {
        const slug = String(args.site_slug);
        const { data: site, error } = await deps.supabase
          .from('sites')
          .select('id')
          .eq('slug', slug)
          .single<{ id: string }>();
        if (error || !site) throw new Error(`site not found: ${slug}`);
        const result = await deps.publishWorker.enqueueRepublish({
          siteId: site.id,
          triggerKind: 'mcp',
          triggeredBy: ctx.adminId,
          reason: args.reason as string | undefined,
          pages: Array.isArray(args.pages) ? (args.pages as string[]) : undefined,
          force: args.force === true,
        });
        return { publishId: result.publishId, tag: null };
      },
    },
    {
      name: 'gatewaze.get_site_status',
      description: 'Fetch current status, git provenance, last publish info, and in-flight publish count for a site.',
      inputSchema: {
        type: 'object',
        required: ['site_slug'],
        properties: { site_slug: { type: 'string' } },
      },
      handler: async (args) => {
        const slug = String(args.site_slug);
        const { data: site, error } = await deps.supabase
          .from('sites')
          .select('id, slug, name, status, git_provenance, git_url, updated_at')
          .eq('slug', slug)
          .single();
        if (error || !site) throw new Error(`site not found: ${slug}`);
        return {
          slug: site.slug,
          name: site.name,
          status: site.status,
          git_provenance: site.git_provenance,
          git_url: site.git_url,
          last_publish_at: null, // populated when site_republish_log query is wired
          in_flight_publishes: 0,
        };
      },
    },
    {
      name: 'gatewaze.list_sites',
      description: 'List all sites with their slug, name, status.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        // The narrow query interface doesn't expose array results yet; this is a
        // placeholder until the MCP integration wires a richer Supabase client.
        return [];
      },
    },
    {
      name: 'gatewaze.send_edition',
      description: 'Trigger sending a newsletter edition. Enqueues the send job; commits the edition under editions/<slug>/ on the list publish branch.',
      inputSchema: {
        type: 'object',
        required: ['list_slug', 'edition_id'],
        properties: {
          list_slug: { type: 'string' },
          edition_id: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      handler: async () => {
        // Stub: full implementation lives in the newsletters module's send worker.
        throw new Error('send_edition not yet wired (see newsletters module mcp-tools.ts when implemented)');
      },
    },
  ];
}
