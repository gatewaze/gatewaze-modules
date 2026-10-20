/**
 * MCP contributions. The platform catalogues these at GET /api/v1/mcp/tools
 * (namespaced content-sources_<name>); the hosted MCP server
 * (gatewaze/packages/mcp) exposes the callable versions by calling the public
 * API with the caller's token, so scope enforcement happens once, in the API.
 * The handlers here are the same logic, for a runtime that does invoke
 * module tools directly (ctx.supabase is the service-role client and carries
 * no caller identity, so only read tools and the always-pending submit are
 * offered here; set_status lives in the hosted server behind the admin scope).
 */

import type { McpContributions, ModuleRuntimeContext } from '@gatewaze/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
// Loaded lazily through a non-literal specifier: the admin bundle imports this
// file (via index.ts) for the tool catalogue, and lib/sources.js pulls in the
// Node-only fetch stack, which must never be bundled for the browser.
type SourcesLib = typeof import('./lib/sources.js');
const SOURCES_LIB = './lib/sources.js';
const lib = (): Promise<SourcesLib> => import(/* @vite-ignore */ SOURCES_LIB) as Promise<SourcesLib>;

export function getContentSourcesMcpContributions(): McpContributions {
  return {
    tools: [
      {
        name: 'list',
        description: 'List discovery sources (feeds and sites the platform watches for new posts). Filter by status, foundation or free text.',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending', 'active', 'paused', 'dead'] },
            foundation: { type: 'string' },
            q: { type: 'string', description: 'Free-text match on project, foundation, feed or site URL' },
            limit: { type: 'number', description: 'Max results (default 25, max 100)' },
            offset: { type: 'number' },
          },
        },
        handler: async (params, ctx: ModuleRuntimeContext) => {
          const limit = Math.min(Math.max(Number(params.limit) || 25, 1), 100);
          const offset = Math.max(Number(params.offset) || 0, 0);
          return (await lib()).list(ctx.supabase as SupabaseClient, { status: params.status, foundation: params.foundation, q: params.q, limit, offset });
        },
      },
      {
        name: 'get',
        description: 'Get one discovery source by id.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        handler: async (params, ctx) => (await lib()).get(ctx.supabase as SupabaseClient, String(params.id)),
      },
      {
        name: 'resolve',
        description: 'Given a site URL, find its RSS/Atom feed candidates without saving anything.',
        inputSchema: { type: 'object', properties: { site_url: { type: 'string' } }, required: ['site_url'] },
        handler: async (params) => (await lib()).resolve(params.site_url),
      },
      {
        name: 'submit',
        description: 'Submit a site or feed URL as a new discovery source. It lands as pending until an admin approves it in Content → Sources.',
        inputSchema: {
          type: 'object',
          properties: {
            site_url: { type: 'string' },
            feed_url: { type: 'string', description: 'Optional; resolved from the site when omitted' },
            foundation: { type: 'string' },
            project: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['site_url'],
        },
        handler: async (params, ctx) =>
          (await lib()).submit(
            ctx.supabase as SupabaseClient,
            { site_url: params.site_url, feed_url: params.feed_url, foundation: params.foundation, project: params.project, note: params.note },
            { personId: null, addedVia: 'mcp', isAdmin: false },
          ),
      },
    ],
  };
}
