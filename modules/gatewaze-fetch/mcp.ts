/**
 * MCP tool contributions (spec §6).
 *
 * Tools registered:
 *   gw_fetch.fetch_url       — mirror of POST /api/v1/fetch
 *   gw_fetch.extract_content — convenience: fetch + markdown + json_ld
 *   gw_fetch.screenshot      — mirror of POST /api/v1/fetch/screenshot
 *   gw_fetch.get_quota       — mirror of GET /api/v1/fetch/quota
 *
 * Implementation: each handler makes an HTTP call to the Gatewaze
 * public API using the X-API-Key resolved from one of two sources:
 *   - stdio MCP: GATEWAZE_FETCH_API_KEY env var (read once at boot)
 *   - HTTP MCP: X-Gatewaze-Fetch-Key header (per request, exposed via
 *     ctx.fetchApiKey in the MCP server's tool dispatch)
 *
 * This dual-token shape is documented in spec §4.2; collapses to a
 * single token in MCP-server v2.
 */

import type { McpContributions, ModuleRuntimeContext } from '@gatewaze/shared';
import { z } from 'zod';

interface ToolCallContext extends ModuleRuntimeContext {
  /** HTTP-MCP only: the per-request fetch key from X-Gatewaze-Fetch-Key. */
  fetchApiKey?: string;
}

export function buildMcpContributions(_ctx: ModuleRuntimeContext): McpContributions {
  // Resolve the fetch API key + endpoint at module init.
  const stdioFetchKey = process.env.GATEWAZE_FETCH_API_KEY ?? null;
  const apiBaseUrl =
    process.env.GATEWAZE_API_PUBLIC_BASE_URL ??
    process.env.GATEWAZE_API_BASE_URL ??
    'http://localhost:3000';

  function resolveKey(toolCtx: ToolCallContext): string | null {
    return toolCtx.fetchApiKey ?? stdioFetchKey;
  }

  async function callPublicApi(
    method: 'GET' | 'POST',
    path: string,
    apiKey: string,
    body: unknown = null,
  ): Promise<{ status: number; data: unknown }> {
    const init: RequestInit = {
      method,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: body === null ? undefined : JSON.stringify(body),
    };
    const res = await fetch(`${apiBaseUrl}/api/v1/fetch${path}`, init);
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const json = await res.json();
      return { status: res.status, data: json };
    }
    return { status: res.status, data: await res.text() };
  }

  function maybeKeyError(toolCtx: ToolCallContext) {
    const key = resolveKey(toolCtx);
    if (!key) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              'FETCH_KEY_REQUIRED: a Gatewaze API key with the gatewaze-fetch:read scope is required. ' +
              'Set GATEWAZE_FETCH_API_KEY in the MCP process environment (stdio) ' +
              'or pass X-Gatewaze-Fetch-Key on the MCP HTTP request.',
          },
        ],
        isError: true,
      };
    }
    return key;
  }

  // ---- truncation helper for large MCP outputs ---------------------
  // Spec §6.1: output is truncated at 256 KiB with _truncated and
  // _full_size_bytes set; agents use the REST endpoint with
  // response_storage: signed_url for full content.
  const MCP_MAX_TOOL_OUTPUT_BYTES = 256 * 1024;

  function truncateOutputForMcp(value: unknown): {
    payload: unknown;
    truncated: boolean;
    full_size_bytes: number;
  } {
    const json = JSON.stringify(value);
    const fullSize = Buffer.byteLength(json, 'utf-8');
    if (fullSize <= MCP_MAX_TOOL_OUTPUT_BYTES) {
      return { payload: value, truncated: false, full_size_bytes: fullSize };
    }
    // Best-effort truncation: stringify, slice, parse-fallback to text.
    const sliced = json.slice(0, MCP_MAX_TOOL_OUTPUT_BYTES - 256);
    let payload: unknown;
    try {
      payload = JSON.parse(sliced + '}');
    } catch {
      payload = { _truncated_raw: sliced };
    }
    return { payload, truncated: true, full_size_bytes: fullSize };
  }

  return {
    tools: [
      {
        name: 'fetch_url',
        title: 'Fetch a URL',
        description:
          'Fetch a single URL and return its content as markdown plus structured metadata. Defaults to a fast HTTP fetch with no JavaScript rendering — pass mode: "browser" only when the page requires JS to render. Requires the gatewaze-fetch:read scope; mode: "browser" additionally requires gatewaze-fetch:browser. Robots.txt is obeyed by default. Best for: reading articles, checking page metadata, scraping non-JS sites. Use gw_fetch.screenshot if you need a rendered image. For pages above ~256 KiB of content, the response will be truncated; in that case, call the equivalent REST endpoint POST /api/v1/fetch with response_storage: "signed_url" and read the full body from the signed URL.',
        inputSchema: z.object({
          url: z.string().url(),
          mode: z.enum(['fast', 'stealth', 'browser']).default('fast'),
          extract: z
            .array(z.enum(['html', 'markdown', 'metadata', 'next_data', 'links', 'json_ld']))
            .default(['markdown', 'metadata']),
          wait_for: z.string().max(256).optional(),
          timeout_ms: z.number().int().min(1000).max(60000).default(30000),
          ignore_robots: z.boolean().default(false),
        }),
        handler: async (input: unknown, toolCtx: ToolCallContext) => {
          const keyOrErr = maybeKeyError(toolCtx);
          if (typeof keyOrErr !== 'string') return keyOrErr;
          const { status, data } = await callPublicApi('POST', '/', keyOrErr, input);
          if (status !== 200) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(data) }],
              isError: true,
            };
          }
          const inner = (data as { data?: unknown }).data ?? data;
          const { payload, truncated, full_size_bytes } = truncateOutputForMcp(inner);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  truncated
                    ? { ...(payload as Record<string, unknown>), _truncated: true, _full_size_bytes: full_size_bytes }
                    : payload,
                ),
              },
            ],
          };
        },
      },
      {
        name: 'extract_content',
        title: 'Fetch and extract structured content',
        description:
          'Fetch a URL and return its content with markdown, metadata, and JSON-LD extraction applied. Equivalent to gw_fetch.fetch_url with mode: "fast" and extract: ["markdown","metadata","json_ld"]. Requires the gatewaze-fetch:read and gatewaze-fetch:extract scopes.',
        inputSchema: z.object({
          url: z.string().url(),
          timeout_ms: z.number().int().min(1000).max(60000).default(30000),
          ignore_robots: z.boolean().default(false),
        }),
        handler: async (input: unknown, toolCtx: ToolCallContext) => {
          const keyOrErr = maybeKeyError(toolCtx);
          if (typeof keyOrErr !== 'string') return keyOrErr;
          const i = input as { url: string; timeout_ms?: number; ignore_robots?: boolean };
          const { status, data } = await callPublicApi('POST', '/', keyOrErr, {
            url: i.url,
            mode: 'fast',
            extract: ['markdown', 'metadata', 'json_ld'],
            timeout_ms: i.timeout_ms ?? 30000,
            ignore_robots: i.ignore_robots ?? false,
          });
          if (status !== 200) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(data) }],
              isError: true,
            };
          }
          const { payload } = truncateOutputForMcp((data as { data?: unknown }).data ?? data);
          return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
        },
      },
      {
        name: 'screenshot',
        title: 'Capture a page screenshot',
        description:
          'Capture a screenshot of a URL using a real browser. Returns a signed URL to a stored PNG (signed URLs expire by default in 10 minutes). Requires the gatewaze-fetch:read, gatewaze-fetch:browser, and gatewaze-fetch:screenshot scopes; counts against the browser-minutes quota.',
        inputSchema: z.object({
          url: z.string().url(),
          options: z
            .object({
              full_page: z.boolean().optional(),
              format: z.enum(['png', 'jpeg']).optional(),
              clip: z
                .object({
                  x: z.number(),
                  y: z.number(),
                  width: z.number(),
                  height: z.number(),
                })
                .nullable()
                .optional(),
            })
            .optional(),
          timeout_ms: z.number().int().min(1000).max(60000).default(45000),
          ignore_robots: z.boolean().default(false),
        }),
        handler: async (input: unknown, toolCtx: ToolCallContext) => {
          const keyOrErr = maybeKeyError(toolCtx);
          if (typeof keyOrErr !== 'string') return keyOrErr;
          const i = input as Record<string, unknown>;
          const { status, data } = await callPublicApi('POST', '/screenshot', keyOrErr, {
            ...i,
            response_storage: 'signed_url', // MCP always uses signed URL
          });
          if (status !== 200) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(data) }],
              isError: true,
            };
          }
          const inner = (data as { data?: { screenshot?: unknown } }).data ?? data;
          const screenshot = (inner as { screenshot?: unknown }).screenshot;
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(screenshot ?? inner) }],
          };
        },
      },
      {
        name: 'get_quota',
        title: 'Read the calling key\'s remaining quota',
        description:
          'Return the calling key\'s monthly quota state: requests, browser-minutes, proxy-GB, and per-minute rate cap. Useful before issuing a long-running batch of fetches. Requires the gatewaze-fetch:read scope.',
        inputSchema: z.object({}),
        handler: async (_input: unknown, toolCtx: ToolCallContext) => {
          const keyOrErr = maybeKeyError(toolCtx);
          if (typeof keyOrErr !== 'string') return keyOrErr;
          const { status, data } = await callPublicApi('GET', '/quota', keyOrErr);
          if (status !== 200) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(data) }],
              isError: true,
            };
          }
          const inner = (data as { data?: unknown }).data ?? data;
          return { content: [{ type: 'text' as const, text: JSON.stringify(inner) }] };
        },
      },
    ],
    resources: [],
    prompts: [],
  } as unknown as McpContributions;
}
