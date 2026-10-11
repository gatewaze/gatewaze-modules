/**
 * Claude Agent SDK provider client — the sanctioned path for
 * `claude_subscription` credentials.
 *
 * Claude Code OAuth tokens are only honoured by Anthropic for requests
 * coming from Claude Code itself: a direct `messages.create` call on one
 * is rejected (429) regardless of headers. This client therefore runs the
 * conversation through `@anthropic-ai/claude-agent-sdk`'s `query()`, which
 * spawns the real Claude Code harness with CLAUDE_CODE_OAUTH_TOKEN — the
 * officially supported way to use a subscription programmatically (the
 * software-engineer module has run this way from day one).
 *
 * Scope: pure model turns only. Every session runs with the built-in tool
 * set hard-disabled (`tools: []`), a deny-all `canUseTool`, and
 * `maxTurns: 1`, so the harness cannot read files, run commands, or reach
 * the network on behalf of a prompt. Callers needing webTools/extraTools
 * must use an api_key credential; images never reach this path (the
 * runner's callers keep those on the direct API).
 *
 * Structured output: the SDK has no native structured-output tool, so the
 * schema contract is appended to the system prompt and the reply is parsed
 * as JSON. Parse failures throw InvalidProviderOutputError, which existing
 * callers already treat as retryable.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ConversationMessage,
  type GenerateImageOpts,
  type GenerateImageResult,
  InvalidProviderOutputError,
  type ProviderClient,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  type RunConversationOpts,
  type RunConversationResult,
} from './types.js';

/**
 * The harness needs headroom for its own turn structure, so the caller's
 * maxOutputTokens is a floor-clamped advisory here, not an exact cap.
 * (The admin credential probe passes 1, which would truncate even "ping".)
 */
const MIN_OUTPUT_TOKENS = 1024;

export class ClaudeAgentProviderClient implements ProviderClient {
  readonly provider = 'anthropic' as const;

  constructor(private readonly oauthToken: string) {}

  capabilities() {
    return {
      streaming: false,
      tools: false,
      web_search: false,
      image_gen: false,
      embeddings: false,
    };
  }

  async runConversation(opts: RunConversationOpts): Promise<RunConversationResult> {
    if (opts.extraTools && opts.extraTools.length > 0) {
      throw new ProviderError(
        'extraTools are not supported on the claude_subscription path — use an api_key credential',
        'anthropic',
      );
    }
    if (opts.webTools && opts.webTools.length > 0) {
      throw new ProviderError(
        'webTools are not supported on the claude_subscription path — use an api_key credential',
        'anthropic',
      );
    }

    // Resolved lazily so environments without the package (e.g. admin
    // builds) can still load the router.
    let query: (args: unknown) => AsyncIterable<Record<string, unknown>>;
    try {
      ({ query } = await import('@anthropic-ai/claude-agent-sdk'));
    } catch {
      throw new ProviderError(
        '@anthropic-ai/claude-agent-sdk is not installed in this runtime',
        'anthropic',
      );
    }

    // Fresh, unpredictable HOME per invocation (CWE-377: a fixed /tmp path
    // could be pre-planted as a symlink by any co-tenant code with file-write
    // reach, redirecting where the harness's config resolves). Removed in the
    // finally block — nothing from a session may outlive the call.
    const agentHome = mkdtempSync(join(tmpdir(), 'gatewaze-claude-agent-'));

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let stderrBuf = '';

    const systemAppend = opts.structuredTool
      ? `${opts.systemPrompt}\n\n${structuredInstruction(opts.structuredTool.name, opts.structuredTool.description, opts.structuredTool.inputSchema)}`
      : opts.systemPrompt;

    const out: RunConversationResult = {
      narrative: '',
      structured: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      durationMs: 0,
      model: opts.model,
      fetchedUrls: [],
      webSearchCount: 0,
      gatewazeSearchCount: 0,
    };

    try {
      const q = query({
        prompt: buildPrompt(opts.messages),
        options: {
          cwd: agentHome,
          model: opts.model,
          env: harnessEnv(agentHome, this.oauthToken, Math.max(MIN_OUTPUT_TOKENS, opts.maxOutputTokens)),
          stderr: (data: string) => { stderrBuf += data; },
          abortController: controller,
          // Prompts on this path carry member health context — the harness
          // must not write session transcripts to disk (its default is to
          // persist every turn under CLAUDE_CONFIG_DIR/projects/).
          persistSession: false,
          // Never load host/user settings — the container may carry a
          // developer's config, and a marketplace reference aborts startup
          // (same rationale as software-engineer's runner).
          settingSources: [],
          systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend },
          // Pure model turn: hard-disable tool availability AND fail closed
          // on approval, and bound the session to a single response.
          tools: [],
          maxTurns: 1,
          allowedTools: [],
          canUseTool: async () => ({
            behavior: 'deny' as const,
            message: 'tools are disabled for this session',
          }),
        },
      });

      let sawResult = false;
      for await (const msg of q) {
        if (msg['type'] !== 'result') continue;
        sawResult = true;
        const usage = (msg['usage'] ?? {}) as Record<string, unknown>;
        out.inputTokens = numberOr(usage['input_tokens'], 0);
        out.outputTokens = numberOr(usage['output_tokens'], 0);
        out.cachedTokens = numberOr(usage['cache_read_input_tokens'], 0);
        out.cacheCreationTokens = numberOr(usage['cache_creation_input_tokens'], 0);
        if (msg['subtype'] !== 'success') {
          throw classifyFailure(String(msg['subtype'] ?? 'unknown'), stderrBuf);
        }
        out.narrative = typeof msg['result'] === 'string' ? msg['result'] : '';
      }
      if (!sawResult) {
        throw classifyFailure('no_result', stderrBuf);
      }
    } catch (err) {
      if (controller.signal.aborted) throw new ProviderTimeoutError('anthropic');
      if (err instanceof ProviderError || err instanceof InvalidProviderOutputError) throw err;
      throw classifyFailure(err instanceof Error ? err.message : String(err), stderrBuf);
    } finally {
      clearTimeout(timer);
      try { rmSync(agentHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }

    out.durationMs = Date.now() - started;

    if (opts.structuredTool) {
      out.structured = parseStructured(out.narrative);
      out.narrative = '';
    }
    return out;
  }

  async generateImage(_opts: GenerateImageOpts): Promise<GenerateImageResult> {
    throw new ProviderError('image generation is not available on the claude_subscription path', 'anthropic');
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Minimal, allowlisted environment for the harness subprocess. Built from
 * scratch — the api/worker env carries service-role keys and DB URLs that
 * a spawned process has no business inheriting, even with tools disabled.
 */
function harnessEnv(agentHome: string, token: string, maxOutputTokens: number): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: agentHome,
    CLAUDE_CONFIG_DIR: agentHome,
    TMPDIR: agentHome,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

/**
 * The SDK takes a single prompt, not a turn array, so prior turns are
 * serialised into a transcript block and the trailing user message becomes
 * the live ask. tool_result rows (rare on this path) are folded in as
 * labelled context lines.
 */
function buildPrompt(messages: ConversationMessage[]): string {
  const turns = messages.filter((m) => String(m.content ?? '').trim());
  if (turns.length === 0) return '[The member opens the conversation.]';
  const last = turns[turns.length - 1];
  const history = turns.slice(0, -1);
  if (history.length === 0 && last.role === 'user') return last.content;

  const lines = history.map((m) => `[${m.role}] ${m.content}`).join('\n\n');
  const ask = last.role === 'user'
    ? last.content
    : '[Continue the conversation as the assistant.]';
  return `<conversation_history>\n${lines}\n</conversation_history>\n\n${ask}`;
}

function structuredInstruction(
  name: string,
  description: string,
  schema: Record<string, unknown>,
): string {
  return [
    `Your entire reply must be a single JSON object — the input you would pass to the tool "${name}" (${description}).`,
    `It must validate against this JSON Schema:`,
    JSON.stringify(schema),
    `Output ONLY the JSON object. No prose before or after, no code fences.`,
  ].join('\n');
}

function parseStructured(text: string): Record<string, unknown> {
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const candidates = [cleaned];
  const first = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (first >= 0 && lastBrace > first) candidates.push(cleaned.slice(first, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  throw new InvalidProviderOutputError('claude agent reply was not a JSON object', 'anthropic');
}

/**
 * Map a harness failure to the router's error taxonomy WITHOUT echoing the
 * session content: stderr can quote API error bodies, which can quote the
 * prompt, and prompts on this path carry member health context. Only
 * recognised markers cross the boundary.
 */
function classifyFailure(subtype: string, stderr: string): ProviderError {
  const haystack = `${subtype}\n${stderr}`;
  if (/rate.?limit|429|overloaded/i.test(haystack)) {
    return new ProviderRateLimitError('anthropic', null);
  }
  if (/credit balance is too low/i.test(haystack)) {
    return new ProviderError('credit balance is too low', 'anthropic', 400, false);
  }
  if (/invalid bearer token|authentication_error|401/i.test(haystack)) {
    return new ProviderError('subscription token rejected (authentication_error)', 'anthropic', 401, false);
  }
  return new ProviderError(`claude agent session failed (${subtype.slice(0, 80)})`, 'anthropic', 0, true);
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
