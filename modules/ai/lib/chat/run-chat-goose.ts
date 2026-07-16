/**
 * spec-ai-mcp-extensions.md §6 §High-level flow (chat turn).
 *
 * Replaces the in-house runChat TS path with a Goose-CLI-backed
 * chat wrapper. Spawns `goose run --quiet --no-session
 * --output-format stream-json` with the resolved system prompt
 * (skill body or inline) + the use case's MCP extension allowlist.
 * Multi-turn history is replayed via stdin --text invocations on each
 * call; Goose persists nothing of its own — ai_threads + ai_messages
 * remain canonical.
 *
 * Activation: AI_CHAT_EXECUTOR=goose flips this on. Default during
 * rollout is the legacy runChat path; once parity is verified the TS
 * runner becomes dead code.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { recordUsage } from '../cost.js';
import type { RunnerContext } from '../runner.js';

const GOOSE_BIN = process.env.GOOSE_BIN ?? '/usr/local/bin/goose';
const MAX_TURN_DURATION_MS = 10 * 60 * 1000;
const CANCELLATION_GRACE_MS = 5_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = { from(table: string): any };

export interface ChatTurn {
  role: 'user' | 'assistant' | 'tool_summary';
  content: string;
}

export interface RunChatViaGooseArgs {
  threadId: string;
  assistantMessageId: string;
  useCase: string;
  userId: string | null;
  /** Resolved system prompt (skill body or inline). */
  systemPrompt: string;
  /** Full prior conversation, oldest first. The wrapper replays via stdin. */
  history: ChatTurn[];
  /** The new user message that triggers this turn. */
  userMessage: string;
  provider?: string;
  model?: string;
  /**
   * Streaming hook the worker handler wires to Redis Stream XADD
   * on ai:thread:<threadId>.
   */
  onStreamEvent?: (event: Record<string, unknown>) => Promise<void> | void;
}

export interface RunChatViaGooseResult {
  ok: boolean;
  /** Final assistant text (concatenation of streamed message deltas). */
  content: string;
  /** Structured-tool args, if the agent called one. */
  structured: Record<string, unknown> | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_micro_usd: number;
  provider: string | null;
  model: string | null;
  loaded_mcp_server_names: string[];
  mcp_warnings: Array<Record<string, unknown>>;
  duration_ms: number;
  failure_reason?: string;
}

export async function runChatViaGoose(
  supabase: SupabaseClient,
  _ctx: RunnerContext,
  args: RunChatViaGooseArgs,
): Promise<RunChatViaGooseResult> {
  const start = Date.now();

  // Resolve MCP extensions from the use-case allowlist. For chat there
  // is no recipe to intersect against — pass the full allowlist.
  let extensionFlags: string[] = [];
  let extensionEnv: Record<string, string> = {};
  let loadedNames: string[] = [];
  let warnings: Array<Record<string, unknown>> = [];
  try {
    const { resolveChatMcpExtensions } = await import('./resolve-chat-mcp.js');
    const resolved = await resolveChatMcpExtensions(supabase, args.useCase);
    extensionFlags = resolved.flags;
    extensionEnv = resolved.env;
    loadedNames = resolved.loadedNames;
    warnings = resolved.warnings;
  } catch (err) {
    return failResult(start, `chat_mcp_resolve_failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Per-use-case Goose runtime overrides.
  let overrides: Record<string, string> = {};
  try {
    const res = await supabase
      .from('ai_use_cases')
      .select('goose_runtime_overrides, max_output_tokens')
      .eq('id', args.useCase)
      .maybeSingle();
    const row = res.data as { goose_runtime_overrides?: Record<string, unknown>; max_output_tokens?: number | null } | null;
    // Honor the use case's output cap. Goose defaults max_tokens to 4096; a
    // large copilot edit (regenerating the document) overruns that and the
    // response truncates. Seed GOOSE_MAX_TOKENS from max_output_tokens; explicit
    // goose_runtime_overrides below still win. (Mirrors run-recipe-goose.)
    if (typeof row?.max_output_tokens === 'number' && row.max_output_tokens > 0) {
      overrides.GOOSE_MAX_TOKENS = String(row.max_output_tokens);
    }
    const o = row?.goose_runtime_overrides ?? {};
    for (const [k, v] of Object.entries(o)) {
      if (v != null) overrides[k] = typeof v === 'string' ? v : String(v);
    }
  } catch {
    // best-effort
  }

  const maxTurns = Math.max(1, Number(overrides.GATEWAZE_GOOSE_MAX_TURNS ?? process.env.GATEWAZE_GOOSE_MAX_TURNS ?? '20'));
  const maxToolRepetitions = Math.max(1, Number(overrides.GATEWAZE_GOOSE_MAX_TOOL_REPETITIONS ?? process.env.GATEWAZE_GOOSE_MAX_TOOL_REPETITIONS ?? '30'));

  const tmpd = await mkdtemp(join(osTmpdir(), `gatewaze-chat-${args.threadId}-`));

  // Serialize prior history into the system prompt as a "Prior conversation"
  // context block. Goose's session command's --text flag accepts only the
  // single new user turn; replaying earlier turns through stdin would
  // require pinning against a specific Goose session protocol version.
  // The system-prompt context-block approach is forward-compatible across
  // Goose versions and matches the in-house runChat's behavior bit-for-bit
  // (the messages[] array we used to pass became Anthropic/OpenAI's
  // alternating-role transcript; here it becomes a serialised block).
  const effectiveSystemPrompt = serializeHistoryIntoPrompt(args.systemPrompt, args.history);

  // Goose v1.34 split chat into `goose session` (interactive, requires
  // a TTY) and `goose run` (one-shot, non-interactive). For background
  // chat-turn execution we want the one-shot variant. The previous
  // `goose session --no-tty` invocation worked on older Gooses but
  // started failing with "unexpected argument '--no-tty'" once the
  // CLI was upgraded — `--no-tty` was dropped because `goose run`
  // never opens a TTY in the first place.
  const gooseArgs = [
    'run',
    '--quiet',
    '--no-session',
    '--output-format', 'stream-json',
    '--system', effectiveSystemPrompt,
    '--text', args.userMessage,
    '--max-turns', String(maxTurns),
    '--max-tool-repetitions', String(maxToolRepetitions),
    ...(args.provider ? ['--provider', args.provider] : []),
    ...(args.model ? ['--model', args.model] : []),
    ...extensionFlags,
  ];

  let child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  let stdoutBuf = '';
  let stderrBuf = '';
  let finalContent = '';
  let structured: Record<string, unknown> | null = null;
  let totalIn = 0;
  let totalOut = 0;
  let provider: string | null = null;
  let model: string | null = null;
  let failureReason: string | undefined;
  // MCP tool-call telemetry: { server, tool, latencyMs }. toolRequest
  // events are stamped with started_at; toolResponse pairs by tool-
  // call id when present, else by ordinal sequence within the run.
  const mcpToolCalls: Array<{ server: string; tool: string; latencyMs: number }> = [];
  const pendingToolReqs = new Map<string, { server: string; tool: string; startedAt: number }>();

  try {
    child = spawn(GOOSE_BIN, gooseArgs, {
      cwd: tmpd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GATEWAZE_USE_CASE: args.useCase,
        ...(args.userId ? { GATEWAZE_USER_ID: args.userId } : {}),
        GATEWAZE_THREAD_ID: args.threadId,
        ...extensionEnv,
        ...overrides,
      },
    }) as ChildProcessByStdio<Writable, Readable, Readable>;
  } catch (err) {
    await rm(tmpd, { recursive: true, force: true }).catch(() => undefined);
    return failResult(start, `chat_spawn_failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Replay prior history through stdin. Goose's --text is the FIRST
  // user turn; subsequent --text invocations (sent here via stdin
  // protocol when available) carry the rest. v1 minimal: we don't
  // currently splice history into Goose's running session; the
  // system prompt + this one --text is the input. Multi-turn history
  // is included by serialising prior turns into a context block at
  // the END of the systemPrompt — same UX guarantee.
  // (Future: switch to Goose's actual interactive stdin protocol
  // once we've validated against a pinned Goose version.)
  child.stdin.end();

  const cancelTimer = setTimeout(() => {
    if (child && !child.killed) child.kill('SIGTERM');
    setTimeout(() => {
      if (child && !child.killed) child.kill('SIGKILL');
    }, CANCELLATION_GRACE_MS);
  }, MAX_TURN_DURATION_MS);

  try {
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', async (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        await args.onStreamEvent?.(event);
        if (event.type === 'message') {
          const msg = (event.message ?? event) as { content?: unknown[] };
          if (Array.isArray(msg.content)) {
            for (const item of msg.content) {
              if (!item || typeof item !== 'object') continue;
              const it = item as { type?: string; text?: string; toolCall?: { value?: { name?: string; arguments?: unknown } } };
              if (it.type === 'text' && typeof it.text === 'string') {
                finalContent += it.text;
              } else if (it.type === 'toolRequest' && it.toolCall?.value) {
                const toolName = it.toolCall.value.name;
                const toolCallId = (it as { id?: string }).id;
                if (typeof toolName === 'string' && toolName.includes('__')) {
                  const sep = toolName.indexOf('__');
                  const ext = toolName.slice(0, sep);
                  const tool = toolName.slice(sep + 2);
                  if (loadedNames.includes(ext) && typeof toolCallId === 'string') {
                    // Record the start time; latency computed on toolResponse.
                    pendingToolReqs.set(toolCallId, { server: ext, tool, startedAt: Date.now() });
                  }
                }
                // Capture structured-output tool args (recipe__final_output style)
                if (toolName === 'recipe__final_output' || toolName === 'submit_result') {
                  const argsField = it.toolCall.value.arguments;
                  if (argsField && typeof argsField === 'object') {
                    structured = argsField as Record<string, unknown>;
                  }
                }
              } else if (it.type === 'toolResponse') {
                // Pair with the matching toolRequest by id (Goose's
                // stream-json id+toolResponse.id symmetry). Latency =
                // toolResponse arrival - toolRequest emission.
                const respId = (it as { id?: string; toolResult?: unknown }).id;
                if (typeof respId === 'string' && pendingToolReqs.has(respId)) {
                  const req = pendingToolReqs.get(respId)!;
                  pendingToolReqs.delete(respId);
                  mcpToolCalls.push({
                    server: req.server,
                    tool: req.tool,
                    latencyMs: Date.now() - req.startedAt,
                  });
                }
              }
            }
          }
        } else if (event.type === 'complete') {
          const cmp = event as Record<string, unknown>;
          const total = numericOr(cmp.total_tokens, 0);
          totalIn = numericOr(cmp.input_tokens, 0);
          totalOut = numericOr(cmp.output_tokens, total - totalIn);
          if (totalOut < 0) totalOut = total;
          provider = typeof cmp.provider === 'string' ? cmp.provider : null;
          model = typeof cmp.model === 'string' ? cmp.model : null;
        } else if (event.type === 'error') {
          failureReason = `goose_runtime_error: ${typeof event.error === 'string' ? event.error : JSON.stringify(event.error)}`;
        }
      }
    });
    child.stderr.on('data', (chunk: string) => { stderrBuf += chunk; });

    const exitCode = await new Promise<number>((resolve) => {
      child!.on('exit', (code) => resolve(code ?? -1));
    });
    clearTimeout(cancelTimer);

    if (exitCode !== 0 && !failureReason) {
      // Include the tail of stdoutBuf alongside stderr so a silent
      // exit (no stderr written) still leaves a clue. Also emit a
      // worker-log line with the full args + buffers so operators
      // can post-mortem from `docker logs example-worker` even when the
      // ai_messages row only gets the truncated string.
      const stderrTail = stderrBuf.slice(-1500);
      const stdoutTail = stdoutBuf.slice(-1500);
      try {
        // eslint-disable-next-line no-console
        console.error('[chat-goose] non-zero exit', {
          exitCode,
          gooseArgs,
          stderrTail,
          stdoutTail,
        });
      } catch { /* logging best-effort */ }
      failureReason = `goose_exit_${exitCode}: stderr=${stderrTail || '(empty)'} | stdout_tail=${stdoutTail.slice(-400)}`;
    }

    // Drain any toolRequests that never paired with a toolResponse —
    // can happen if the run terminates mid-tool. Best-effort latency
    // = (end-of-run - start). The ledger row still gets written so
    // operators can spot a hung tool by its outlier latency.
    for (const [, pending] of pendingToolReqs) {
      mcpToolCalls.push({
        server: pending.server,
        tool: pending.tool,
        latencyMs: Date.now() - pending.startedAt,
      });
    }
    pendingToolReqs.clear();

    // Cost ledger — llm row + per mcp_tool row.
    if ((totalIn > 0 || totalOut > 0) && provider && model) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await recordUsage(supabase as any, {
          userId: args.userId,
          useCase: args.useCase,
          threadId: args.threadId,
          messageId: args.assistantMessageId,
          kind: 'llm',
          provider: provider as never,
          model,
          inputTokens: totalIn,
          outputTokens: totalOut,
          latencyMs: Date.now() - start,
          status: failureReason ? 'error' : 'ok',
          error: failureReason ?? null,
        });
      } catch {/* best-effort */}
    }
    for (const call of mcpToolCalls) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await recordUsage(supabase as any, {
          userId: args.userId,
          useCase: args.useCase,
          threadId: args.threadId,
          messageId: args.assistantMessageId,
          kind: 'mcp_tool',
          provider: call.server as never,
          model: call.tool,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: call.latencyMs,
          status: 'ok',
          error: null,
        });
      } catch {/* best-effort */}
    }

    return {
      ok: !failureReason,
      content: finalContent,
      structured,
      total_input_tokens: totalIn,
      total_output_tokens: totalOut,
      total_cost_micro_usd: 0,
      provider,
      model,
      loaded_mcp_server_names: loadedNames,
      mcp_warnings: warnings,
      duration_ms: Date.now() - start,
      ...(failureReason && { failure_reason: failureReason }),
    };
  } finally {
    clearTimeout(cancelTimer);
    if (child && !child.killed) child.kill('SIGTERM');
    await rm(tmpd, { recursive: true, force: true }).catch(() => undefined);
  }
}

function numericOr(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return fallback;
}

/**
 * Serialize prior conversation history into a system-prompt context
 * block. Goose v1.34's `goose session --text` accepts only the single
 * new turn; this block carries everything before it.
 *
 * Wrapped in fenced section markers so the model can clearly
 * distinguish "context I should treat as already-said" from the
 * operator-authored system prompt above. Empty history → no block
 * appended (keeps single-turn prompts clean).
 */
export function serializeHistoryIntoPrompt(
  systemPrompt: string,
  history: ChatTurn[],
): string {
  if (history.length === 0) return systemPrompt;

  const lines: string[] = [];
  lines.push(systemPrompt);
  lines.push('');
  lines.push('---');
  lines.push('## Prior conversation in this thread');
  lines.push('');
  lines.push('The conversation below has already occurred. The current user turn follows after this block. Continue naturally from here; do not repeat prior responses.');
  lines.push('');
  for (const turn of history) {
    const role = turn.role === 'tool_summary' ? 'tool' : turn.role;
    lines.push(`### ${role}`);
    lines.push(turn.content);
    lines.push('');
  }
  lines.push('---');
  return lines.join('\n');
}

function failResult(start: number, reason: string): RunChatViaGooseResult {
  return {
    ok: false,
    content: '',
    structured: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost_micro_usd: 0,
    provider: null,
    model: null,
    loaded_mcp_server_names: [],
    mcp_warnings: [],
    duration_ms: Date.now() - start,
    failure_reason: reason,
  };
}
