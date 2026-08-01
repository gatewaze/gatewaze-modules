// @ts-nocheck — @anthropic-ai/claude-agent-sdk is resolved in the runner image at runtime.
/**
 * The Runner seam (spec §7.5). Runs the Claude Agent SDK in-process. Uses a plain STRING prompt
 * for the task (proven to run to completion + stream events), and injects live admin steering via
 * q.streamInput()/q.interrupt() best-effort — NOT an async-generator prompt (that deadlocks: the
 * session waits on the generator and never starts the first turn).
 *
 * Secret isolation: the session env is process.env minus sensitive keys, plus exactly one model
 * credential — the agent's tools never see GATEWAZE_SECRETS_KEY, DB creds, or other brands' secrets.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

export type ModelCredKind = 'anthropic_api_key' | 'claude_code_oauth_token' | 'bedrock' | 'vertex';
export interface PhaseCredential { kind: ModelCredKind; value: string; }
export interface RunnerEvent {
  kind: 'assistant' | 'tool_use' | 'tool_result' | 'thinking' | 'status';
  payload: Record<string, unknown>;
}
export interface AdminInput { kind: 'chat' | 'interrupt' | 'close'; content?: string }
export interface RunnerInput {
  cwd: string;
  prompt: string;
  model: string;
  credential: PhaseCredential;
  allowedTools?: string[];
  systemAppend?: string;
  inputSource?: AsyncIterable<AdminInput>;   // admin → agent bridge (Redis-backed), best-effort
  mcpServers?: Record<string, unknown>;      // §10: connected tools (Gatewaze MCP + per-project servers)
  onEvent?: (ev: RunnerEvent) => void | Promise<void>;
  onAgentMessage?: (text: string) => void | Promise<void>;
}
export interface RunnerResult {
  text: string;
  tokensInput: number;
  tokensOutput: number;
  costUSD: number;
  interrupted: boolean;
  error?: string;
}
/**
 * Interactive (pair-programming) session input. Same seams as RunnerInput, but instead of a one-shot
 * task `prompt` it carries a `kickoff` (the opening user turn) and stays open across turns until the
 * admin closes it — so `inputSource` is REQUIRED (it is the REPL). The session ends when the input
 * stream yields a `close` (or completes / errors).
 */
export interface InteractiveInput {
  cwd: string;
  kickoff: string;
  model: string;
  credential: PhaseCredential;
  allowedTools?: string[];
  systemAppend?: string;
  inputSource: AsyncIterable<AdminInput>;    // admin → agent bridge; drives every turn after kickoff
  mcpServers?: Record<string, unknown>;
  onEvent?: (ev: RunnerEvent) => void | Promise<void>;
  onAgentMessage?: (text: string) => void | Promise<void>;
}
export interface Runner {
  runPhase(input: RunnerInput): Promise<RunnerResult>;
}

function credentialEnv(c: PhaseCredential): Record<string, string> {
  switch (c.kind) {
    case 'anthropic_api_key': return { ANTHROPIC_API_KEY: c.value };
    case 'claude_code_oauth_token': return { CLAUDE_CODE_OAUTH_TOKEN: c.value };
    case 'bedrock': return { CLAUDE_CODE_USE_BEDROCK: '1' };
    case 'vertex': return { CLAUDE_CODE_USE_VERTEX: '1' };
    default: return {};
  }
}

// Keys the agent's tools must NOT see. Spread the rest so the SDK's subprocess has a working env.
const SENSITIVE_ENV = /(SECRET|SERVICE_ROLE|PASSWORD|PRIVATE_KEY|_TOKEN|_KEY$|GATEWAZE_SECRETS_KEY|DATABASE_URL|REDIS|\bJWT\b)/i;

function scopedEnv(c: PhaseCredential): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SENSITIVE_ENV.test(k)) continue;
    env[k] = v;
  }
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;
  Object.assign(env, credentialEnv(c));
  return env;
}

export class InProcessRunner implements Runner {
  async runPhase(input: RunnerInput): Promise<RunnerResult> {
    const out: RunnerResult = { text: '', tokensInput: 0, tokensOutput: 0, costUSD: 0, interrupted: false };
    const env = scopedEnv(input.credential);
    // The SDK collapses any subprocess exit-1 into a generic "Operation aborted"; capture the real
    // stderr so failures are diagnosable (surfaced in out.error / se_phases.error).
    let stderrBuf = '';

    if (!input.prompt || !input.prompt.trim()) {
      out.error = 'empty prompt — refusing to start agent session';
      return out;
    }

    let q: any;
    try {
      q = query({
        prompt: input.prompt, // plain string — runs the task to completion, then the iterator ends
        options: {
          cwd: input.cwd,
          model: input.model,
          env,
          stderr: (data: string) => { stderrBuf += data; },
          // [] — do NOT load the repo's .claude/settings.json: it references a plugin marketplace
          // (@gatewaze-skills) that can't load in the runner container and aborts the session.
          // Instead the repo's CLAUDE.md + .claude/rules are injected into systemAppend by the
          // phase-runner (the documented §5.1 fallback).
          settingSources: [],
          // §10: connected tools. Only pass when non-empty — an empty object is a no-op but we keep
          // the option absent so the SDK path is identical to before when no servers are configured.
          ...(input.mcpServers && Object.keys(input.mcpServers).length ? { mcpServers: input.mcpServers } : {}),
          systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemAppend ?? '' },
          // NOT 'bypassPermissions' — that maps to --dangerously-skip-permissions, which the claude
          // binary refuses under root/sudo (the runner container runs as root). Instead we approve
          // via canUseTool: bare allowedTools entries auto-approve, and anything else falls through
          // to the callback below (which allows it). No dangerous flag → works as root. The Bash
          // PreToolUse hook still enforces the forbidden-flag guard regardless of approval mode.
          canUseTool: async (_name: string, toolInput: Record<string, unknown>) => ({
            behavior: 'allow' as const,
            updatedInput: toolInput,
          }),
          allowedTools: input.allowedTools ?? ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
          hooks: {
            PreToolUse: [{
              matcher: 'Bash',
              hooks: [async (i: any) => {
                const cmd = i?.tool_input?.command ?? '';
                if (/--no-verify|--force|rm\s+-rf\s+\//.test(cmd)) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: 'forbidden git/destructive flag (software-engineer guard)',
                    },
                  };
                }
                return {};
              }],
            }],
          },
        },
      });
    } catch (e: any) {
      out.error = e?.message || String(e);
      return out;
    }

    // Live admin steering (best-effort, fire-and-forget). Ends when the run closes inputSource.
    const controller = (async () => {
      if (!input.inputSource) return;
      for await (const m of input.inputSource) {
        try {
          if (m?.kind === 'interrupt') {
            out.interrupted = true;
            await q.interrupt?.();
          } else if (m?.kind === 'chat' && m.content) {
            await q.streamInput?.((async function* () {
              yield { type: 'user', message: { role: 'user', content: String(m.content) } };
            })());
          }
        } catch { /* injection is best-effort */ }
      }
    })().catch(() => {});

    let turnText = '';
    try {
      for await (const msg of q) {
        if (msg?.type === 'assistant') {
          for (const b of msg.message?.content ?? []) {
            if (b?.type === 'text') {
              out.text += b.text;
              turnText += b.text;
              await input.onEvent?.({ kind: 'assistant', payload: { text: b.text, agent: msg.parent_tool_use_id ?? null } });
            } else if (b?.type === 'tool_use') {
              await input.onEvent?.({ kind: 'tool_use', payload: { name: b.name, input: b.input, agent: msg.parent_tool_use_id ?? null } });
            } else if (b?.type === 'thinking' && b.thinking) {
              // Forward extended-thinking so a long reasoning gap between tool calls still shows motion
              // in the Runs tab. Cap the length (bounds the se_events payload) and never forward
              // redacted_thinking (opaque encrypted bytes — no display value, just noise).
              await input.onEvent?.({ kind: 'thinking', payload: { text: String(b.thinking).slice(0, 2000), agent: msg.parent_tool_use_id ?? null } });
            }
          }
        } else if (msg?.type === 'user') {
          for (const b of msg.message?.content ?? []) {
            if (b?.type === 'tool_result') {
              const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
              await input.onEvent?.({ kind: 'tool_result', payload: { summary: String(c).slice(0, 600) } });
            }
          }
        } else if (msg?.type === 'result') {
          out.costUSD = msg.total_cost_usd ?? out.costUSD;
          out.tokensInput += msg.usage?.input_tokens ?? 0;
          out.tokensOutput += msg.usage?.output_tokens ?? 0;
          if (turnText.trim()) { await input.onAgentMessage?.(turnText.trim()); turnText = ''; }
        }
      }
    } catch (e: any) {
      out.error = e?.message || String(e);
    }
    void controller;
    // Prefer the subprocess's real stderr over the SDK's opaque "Operation aborted".
    if (out.error && stderrBuf.trim()) {
      out.error = `${out.error} :: ${stderrBuf.trim().slice(-1500)}`;
    }
    out.text = out.text.trim();
    return out;
  }

  /**
   * Long-lived interactive session (pair-programming). Unlike runPhase — which runs a plain STRING
   * prompt and ends after one task — this drives the SDK in STREAMING-INPUT mode: the `prompt` is an
   * async generator whose first yield is the kickoff (yielded SYNCHRONOUSLY so turn 1 starts — a
   * generator that awaits input before its first yield deadlocks: the session waits on the generator
   * that is itself waiting on the admin), and each subsequent admin `chat` becomes another turn. The
   * generator RETURNS on `close` (or when the input stream completes / the idle+wall-clock wrapper
   * ends it), which ends the SDK session cleanly. `interrupt` maps to q.interrupt() without ending it.
   *
   * Same secret-scoped env, tool-approval, and Bash guard as runPhase.
   */
  async runInteractive(input: InteractiveInput): Promise<RunnerResult> {
    const out: RunnerResult = { text: '', tokensInput: 0, tokensOutput: 0, costUSD: 0, interrupted: false };
    const env = scopedEnv(input.credential);
    let stderrBuf = '';

    if (!input.kickoff || !input.kickoff.trim()) {
      out.error = 'empty kickoff — refusing to start interactive session';
      return out;
    }

    let q: any;
    // The streaming-input generator IS the prompt. `q` is referenced only inside the loop body (for
    // interrupt), which runs after query() has assigned it, so the forward reference is safe.
    async function* promptStream() {
      yield { type: 'user', message: { role: 'user', content: input.kickoff } };
      try {
        for await (const m of input.inputSource) {
          if (m?.kind === 'close') return;                       // graceful end → session completes
          if (m?.kind === 'interrupt') {
            out.interrupted = true;
            try { await q?.interrupt?.(); } catch { /* best-effort */ }
            continue;
          }
          if (m?.kind === 'chat' && m.content) {
            yield { type: 'user', message: { role: 'user', content: String(m.content) } };
          }
        }
      } catch { /* input stream error → let the generator return and end the session */ }
    }

    try {
      q = query({
        prompt: promptStream(),
        options: {
          cwd: input.cwd,
          model: input.model,
          env,
          stderr: (data: string) => { stderrBuf += data; },
          settingSources: [],
          ...(input.mcpServers && Object.keys(input.mcpServers).length ? { mcpServers: input.mcpServers } : {}),
          systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemAppend ?? '' },
          canUseTool: async (_name: string, toolInput: Record<string, unknown>) => ({
            behavior: 'allow' as const,
            updatedInput: toolInput,
          }),
          allowedTools: input.allowedTools ?? ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
          hooks: {
            PreToolUse: [{
              matcher: 'Bash',
              hooks: [async (i: any) => {
                const cmd = i?.tool_input?.command ?? '';
                if (/--no-verify|--force|rm\s+-rf\s+\//.test(cmd)) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: 'forbidden git/destructive flag (software-engineer guard)',
                    },
                  };
                }
                return {};
              }],
            }],
          },
        },
      });
    } catch (e: any) {
      out.error = e?.message || String(e);
      return out;
    }

    let turnText = '';
    try {
      for await (const msg of q) {
        if (msg?.type === 'assistant') {
          for (const b of msg.message?.content ?? []) {
            if (b?.type === 'text') {
              out.text += b.text;
              turnText += b.text;
              await input.onEvent?.({ kind: 'assistant', payload: { text: b.text, agent: msg.parent_tool_use_id ?? null } });
            } else if (b?.type === 'tool_use') {
              await input.onEvent?.({ kind: 'tool_use', payload: { name: b.name, input: b.input, agent: msg.parent_tool_use_id ?? null } });
            } else if (b?.type === 'thinking' && b.thinking) {
              await input.onEvent?.({ kind: 'thinking', payload: { text: String(b.thinking).slice(0, 2000), agent: msg.parent_tool_use_id ?? null } });
            }
          }
        } else if (msg?.type === 'user') {
          for (const b of msg.message?.content ?? []) {
            if (b?.type === 'tool_result') {
              const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
              await input.onEvent?.({ kind: 'tool_result', payload: { summary: String(c).slice(0, 600) } });
            }
          }
        } else if (msg?.type === 'result') {
          out.costUSD = msg.total_cost_usd ?? out.costUSD;
          out.tokensInput += msg.usage?.input_tokens ?? 0;
          out.tokensOutput += msg.usage?.output_tokens ?? 0;
          // Each result closes one turn — flush that turn's text as an agent chat message so the
          // transcript renders it exactly like an issue run's per-turn replies.
          if (turnText.trim()) { await input.onAgentMessage?.(turnText.trim()); turnText = ''; }
        }
      }
    } catch (e: any) {
      out.error = e?.message || String(e);
    }
    if (out.error && stderrBuf.trim()) {
      out.error = `${out.error} :: ${stderrBuf.trim().slice(-1500)}`;
    }
    out.text = out.text.trim();
    return out;
  }
}
