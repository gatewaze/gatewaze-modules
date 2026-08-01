// @ts-nocheck
/**
 * On-demand project-memory tools for a run's agent session. An in-process SDK MCP server exposing
 * `wiki_search` and `wiki_read`, bound to the run's project use_case (`se-<projectId>`) and its
 * granted source projects. The agent calls these to pull specific memory mid-task, complementing the
 * RAG block prefilled at session start (memory.ts recallMemory).
 *
 * ISOLATION: reads are restricted to an allowlist of use_cases (own + explicitly linked). The agent
 * can never read another tenant's / another use_case's wiki even though the service key technically
 * could — the allowlist is enforced in-process before any read, and the pending proposal is hidden.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { useCaseFor } from './memory.js';

const BASE = () => process.env.GATEWAZE_INTERNAL_API_URL || 'http://api:3002';
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PENDING_SLUG = 'memory-pending';

async function wiki(path: string) {
  const r = await fetch(`${BASE()}/api/modules/ai${path}`, {
    headers: { 'Content-Type': 'application/json', 'x-gatewaze-internal-key': KEY() },
  });
  if (!r.ok) throw new Error(`wiki ${path} → ${r.status}`);
  return r.json();
}

const textResult = (text: string) => ({ content: [{ type: 'text', text }] });

export const MEMORY_TOOL_NAMES = ['mcp__se-memory__wiki_search', 'mcp__se-memory__wiki_read'];

/**
 * Build the memory MCP server for a project session, or null when no wiki is reachable.
 * `linkedSourceProjectIds` are the projects this one recalls from (see listMemorySources).
 */
export function buildMemoryMcpServer(projectId: string, linkedSourceProjectIds: string[] = []) {
  if (!projectId) return null;
  const ownUseCase = useCaseFor(projectId);
  // Allowlist of use_cases this session may read — own + explicitly linked. Nothing else.
  const allowed = new Set<string>([ownUseCase, ...linkedSourceProjectIds.filter(Boolean).map(useCaseFor)]);

  const search = tool(
    'wiki_search',
    "Search this project's durable engineering memory (and any linked projects' approved memory) — hybrid keyword + semantic. Call it to recall past decisions, gotchas, or how something was built before answering. Returns matching pages; use wiki_read to fetch a full page.",
    { query: z.string().describe('What to recall.'), k: z.number().int().optional().describe('Max results (default 8).') },
    async (args) => {
      const q = String(args?.query ?? '').trim().slice(0, 600);
      if (!q) return textResult('(empty query)');
      const k = Math.min(Math.max(Number(args?.k) || 8, 1), 25);
      try {
        const r = await wiki(`/internal/wiki/search?use_case=${encodeURIComponent(ownUseCase)}&q=${encodeURIComponent(q)}&k=${k}&scope=granted`);
        const hits = (r?.results ?? [])
          .filter((h: Record<string, unknown>) => String(h.slug) !== PENDING_SLUG && allowed.has(String(h.use_case ?? ownUseCase)));
        if (!hits.length) return textResult('No matching memory.');
        const lines = hits.map((h: Record<string, unknown>) => {
          const uc = String(h.use_case ?? ownUseCase);
          const from = uc !== ownUseCase ? ` [linked: ${uc}]` : '';
          return `- ${h.title ?? h.slug}${from}\n    use_case=${uc} slug=${h.slug}\n    ${String(h.snippet ?? h.summary ?? '').slice(0, 300)}`;
        });
        return textResult(lines.join('\n'));
      } catch {
        return textResult('(memory search unavailable)');
      }
    },
  );

  const read = tool(
    'wiki_read',
    'Read a full memory page returned by wiki_search. Provide its use_case and slug exactly as given.',
    { slug: z.string().describe('The page slug.'), use_case: z.string().optional().describe('The page use_case from wiki_search (defaults to this project).') },
    async (args) => {
      const slug = String(args?.slug ?? '').trim().slice(0, 400);
      const uc = String(args?.use_case ?? ownUseCase).trim();
      if (!slug) return textResult('(slug required)');
      if (slug === PENDING_SLUG) return textResult('(that page is not readable)');
      if (!allowed.has(uc)) return textResult('(not permitted to read that use_case)');
      try {
        const d = await wiki(`/internal/wiki/read?use_case=${encodeURIComponent(uc)}&slug=${encodeURIComponent(slug)}`);
        if (!d?.found) return textResult('(page not found)');
        return textResult(`# ${d.page?.title ?? slug}\n\n${String(d.page?.body ?? '').slice(0, 12000)}`);
      } catch {
        return textResult('(memory read unavailable)');
      }
    },
  );

  return createSdkMcpServer({ name: 'se-memory', version: '1.0.0', tools: [search, read] });
}
