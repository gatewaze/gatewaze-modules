/**
 * In-process wiki memory tools for the non-Goose chat executor (runChat →
 * providers). spec-ai-memory-wiki.md §5.1. The default chat executor
 * (`AI_CHAT_EXECUTOR ?? 'runChat'`) runs the provider tool-loop in-process,
 * so it can't load the stdio wiki MCP the Goose paths use — instead we expose
 * the same surface as native ExtraTools that resolve straight against the wiki
 * repository (no MCP / HTTP hop). Gated by the use case's wiki_enabled flag
 * (default true) and the global WIKI_RUNTIME_DISABLED kill-switch, matching
 * resolveWikiAttach.
 */

import type { ExtraTool } from '../providers/types.js';
import {
  upsertPage,
  readPage,
  listPages,
  searchPages,
  type WikiDbClient,
  type EmbedFn,
} from './repository.js';

async function wikiEnabled(supabase: WikiDbClient, useCase: string): Promise<boolean> {
  if (process.env.WIKI_RUNTIME_DISABLED === '1') return false;
  try {
    const res = await supabase
      .from('ai_use_cases')
      .select('wiki_enabled')
      .eq('id', useCase)
      .maybeSingle();
    const row = (res.data as { wiki_enabled?: boolean } | null) ?? null;
    if (row && row.wiki_enabled === false) return false;
  } catch {
    // column may not exist yet → default-on
  }
  return true;
}

function makeEmbed(supabase: WikiDbClient): EmbedFn {
  return async (texts: string[], useCase: string): Promise<number[][]> => {
    const { aiEmbed } = await import('../runner.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await aiEmbed({ supabase } as any, { useCase, userId: null, texts, systemRun: true });
    return r.vectors;
  };
}

/**
 * Pre-turn RAG block: hybrid-search the wiki for `query` and format the top
 * hits into the `## Relevant wiki pages` section the runner prepends to the
 * system prompt (spec §5.2), so the model recalls relevant memory without
 * having to call wiki_search first. Returns '' on no query / no hits / error
 * (best-effort — never blocks the turn). The caller gates on wiki_enabled.
 */
export async function buildWikiRagBlock(
  supabase: WikiDbClient,
  useCase: string,
  query: string,
): Promise<string> {
  if (!query || !query.trim()) return '';
  try {
    const { formatWikiContext } = await import('./rag.js');
    const hits = await searchPages(supabase, { useCase, query, k: 5 }, makeEmbed(supabase));
    return formatWikiContext(
      hits as ReadonlyArray<{ use_case?: string; slug: string; title: string; summary?: string | null; snippet?: string }>,
    );
  } catch {
    return '';
  }
}

/**
 * Build the wiki ExtraTools for a use case, or [] when wiki is disabled. The
 * tools mirror the MCP surface: wiki_search / wiki_read / wiki_list /
 * wiki_upsert. `messageId` (the assistant message persisting this turn) is
 * attributed onto pages the model writes.
 */
export async function buildWikiExtraTools(
  supabase: WikiDbClient,
  useCase: string,
  opts: { messageId?: string | null } = {},
): Promise<ExtraTool[]> {
  if (!(await wikiEnabled(supabase, useCase))) return [];
  const embed = makeEmbed(supabase);
  const messageId = opts.messageId ?? null;

  return [
    {
      name: 'wiki_search',
      description:
        "Search this use case's durable wiki memory (hybrid keyword + semantic). Call it to recall facts, decisions, entities, or summaries from earlier turns/runs before answering.",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to recall.' },
          k: { type: 'integer', description: 'Max results (default 5).' },
        },
        required: ['query'],
      },
      resolve: async (args) =>
        searchPages(
          supabase,
          { useCase, query: String(args.query ?? ''), ...(args.k ? { k: Number(args.k) } : {}) },
          embed,
        ),
    },
    {
      name: 'wiki_read',
      description: 'Read a full wiki page by its slug (a path like "topics/x").',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string' } },
        required: ['slug'],
      },
      resolve: async (args) => {
        const page = await readPage(supabase, useCase, String(args.slug ?? ''));
        return { found: !!page, ...(page ? { page } : {}) };
      },
    },
    {
      name: 'wiki_list',
      description: 'List wiki pages, optionally filtered by path prefix and/or category.',
      inputSchema: {
        type: 'object',
        properties: {
          prefix: { type: 'string' },
          category: { type: 'string' },
          limit: { type: 'integer', description: 'Default 100.' },
        },
      },
      resolve: async (args) => ({
        pages: await listPages(supabase, useCase, {
          ...(args.prefix ? { prefix: String(args.prefix) } : {}),
          ...(args.category ? { category: String(args.category) } : {}),
          ...(args.limit ? { limit: Number(args.limit) } : {}),
        }),
      }),
    },
    {
      name: 'wiki_upsert',
      description:
        'Create or update a wiki page (durable cross-turn memory). Use it to persist a fact, decision, entity, or summary worth remembering. slug is a path like "topics/x"; body is markdown and may use [[path/slug]] links.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          summary: { type: 'string' },
          category: { type: 'string' },
        },
        required: ['slug', 'title', 'body'],
      },
      resolve: async (args) =>
        upsertPage(
          supabase,
          {
            useCase,
            slug: String(args.slug),
            title: String(args.title),
            body: String(args.body ?? ''),
            summary: args.summary != null ? String(args.summary) : null,
            category: args.category != null ? String(args.category) : null,
            metadata: {},
            source: 'model',
            messageId,
          },
          embed,
        ),
    },
  ];
}
