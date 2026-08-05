// @ts-nocheck
/**
 * CodexRunner — the OpenAI Codex engine behind the same Runner seam as InProcessRunner (spec §7.5).
 * Drives @openai/codex-sdk, which spawns the bundled Codex CLI and exchanges JSONL events over
 * stdio; resolved dynamically at runPhase time so instances/images without the SDK still load this
 * module and simply report the engine unavailable (model-select degrades those projects to claude
 * before a run ever gets here — this guard is belt-and-braces).
 *
 * Seam mapping and v1 limits (all surfaced honestly, none fail the run):
 *   - systemAppend has no Codex equivalent → prepended to the prompt under a CONTEXT banner.
 *   - mcpServers / plugins (skills) are NOT wired → dropped with a status event so the transcript
 *     says so, rather than silently losing tools.
 *   - noTools (triage-style pure model turns) is unsupported → hard error; model-select never
 *     routes those phases to codex.
 *   - inputSource (live admin steering) is not bridged in v1 → dropped with a status event.
 *   - The runner container is itself the isolation boundary (same argument as the claude path's
 *     allow-all canUseTool): sandbox_mode danger-full-access + approval_policy never, because git
 *     push and package installs are the job. Secret hygiene comes from the scoped env we pass.
 */
import { redactSecrets } from './git.js';

// Env keys the Codex subprocess must not inherit — same posture as agent-session's SENSITIVE_ENV.
const SENSITIVE_ENV = /(SECRET|SERVICE_ROLE|PASSWORD|PRIVATE_KEY|_TOKEN|_KEY$|GATEWAZE_SECRETS_KEY|DATABASE_URL|REDIS|\bJWT\b)/i;

function scopedEnv(openaiKey: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SENSITIVE_ENV.test(k) || v === undefined) continue;
    env[k] = v;
  }
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.OPENAI_API_KEY = openaiKey;
  env.CODEX_API_KEY = openaiKey;
  return env;
}

export class CodexRunner {
  async runPhase(input) {
    const out = { text: '', tokensInput: 0, tokensOutput: 0, tokensCacheRead: 0, tokensCacheCreation: 0, costUSD: 0, interrupted: false };
    if (input.noTools) {
      out.error = 'codex engine does not support no-tools turns — route this phase to claude';
      return out;
    }
    if (!input.prompt || !input.prompt.trim()) {
      out.error = 'empty prompt — refusing to start codex session';
      return out;
    }
    if (!input.credential?.value) {
      out.error = 'codex engine selected but no OpenAI credential on the project';
      return out;
    }

    // Live events reach the admin UI — scrub EVERY run secret (PAT rides in git remote URLs, so
    // `git remote -v` output would leak it), not just the OpenAI key. phase-runner supplies the set.
    const redact = (m) => redactSecrets(String(m ?? ''), [input.credential?.value, ...(input.redactValues ?? [])]);
    let Codex;
    try {
      ({ Codex } = await import('@openai/codex-sdk'));
    } catch (e) {
      out.error = `codex engine unavailable in this runner build (@openai/codex-sdk failed to load: ${e?.message ?? e})`;
      return out;
    }

    // Unsupported seams: say so in the transcript instead of silently degrading.
    if (input.mcpServers && Object.keys(input.mcpServers).length) {
      await input.onEvent?.({ kind: 'status', payload: { text: 'Connected tools (MCP) are not wired to the codex engine yet — running without them.', step: 'codex:no-mcp' } });
    }
    if (input.plugins?.length) {
      await input.onEvent?.({ kind: 'status', payload: { text: 'Project skills are not wired to the codex engine yet — running without them.', step: 'codex:no-skills' } });
    }
    if (input.inputSource) {
      await input.onEvent?.({ kind: 'status', payload: { text: 'Live admin steering is not wired to the codex engine yet.', step: 'codex:no-steering' } });
    }

    const prompt = input.systemAppend
      ? `--- CONTEXT (read before starting; treat as standing instructions for this task) ---\n${input.systemAppend}\n--- TASK ---\n${input.prompt}`
      : input.prompt;

    try {
      const codex = new Codex({
        env: scopedEnv(input.credential.value),
        config: {
          model: input.model,
          // The ephemeral runner container is the sandbox; the job includes git push + installs.
          sandbox_mode: 'danger-full-access',
          approval_policy: 'never',
        },
      });
      const thread = codex.startThread({ workingDirectory: input.cwd, skipGitRepoCheck: true });
      const { events } = await thread.runStreamed(prompt);
      for await (const ev of events) {
        if (ev?.type === 'item.completed') {
          const item = ev.item ?? {};
          if (item.type === 'agent_message' && item.text) {
            out.text += (out.text ? '\n\n' : '') + String(item.text);
            await input.onAgentMessage?.(redact(item.text));
          } else if (item.type === 'command_execution') {
            await input.onEvent?.({ kind: 'tool_use', payload: { name: 'Bash', input: { command: redact(item.command ?? '') }, agent: 'codex' } });
            if (item.aggregated_output != null) {
              await input.onEvent?.({ kind: 'tool_result', payload: { summary: redact(item.aggregated_output).slice(0, 600) } });
            }
          } else if (item.type === 'file_change') {
            const files = (item.changes ?? []).map((c) => c?.path).filter(Boolean).join(', ');
            await input.onEvent?.({ kind: 'tool_use', payload: { name: 'Edit', input: { file_path: files }, agent: 'codex' } });
          } else if (item.type === 'reasoning' && item.text) {
            await input.onEvent?.({ kind: 'thinking', payload: { text: String(item.text).slice(0, 2000), agent: 'codex' } });
          }
        } else if (ev?.type === 'turn.completed') {
          const u = ev.usage ?? {};
          out.tokensInput += u.input_tokens ?? 0;
          out.tokensCacheRead += u.cached_input_tokens ?? 0;
          out.tokensOutput += u.output_tokens ?? 0;
        } else if (ev?.type === 'turn.failed' || ev?.type === 'error') {
          out.error = redact(ev?.error?.message ?? ev?.message ?? 'codex turn failed');
        }
      }
    } catch (e) {
      out.error = redact(e?.message ?? e);
    }
    out.text = out.text.trim();
    return out;
  }
}
