/**
 * Write a post from curated items through the ai module's runChat, the same
 * seam broadcasts' segment copilot and editor-ai-copilot use: runChat owns
 * credentials, the model allow-list, the daily cost cap and the usage ledger
 * (use case 'social-posts-linkedin', seeded by migration 001). This file adds
 * only the prompt, one corrective retry, and the post-processing in
 * formats.ts.
 */

import {
  buildSystemPrompt,
  buildUserPrompt,
  EMIT_POST_TOOL,
  finishPost,
  overLimit,
  PLATFORMS,
  trimToLimit,
  type FinishedPost,
  type Format,
  type Platform,
} from './formats.js';
import type { PoolItem } from './pool-types.js';

export interface RunChatResult {
  structured: Record<string, unknown> | null;
  model?: string;
  costMicroUsd?: number;
}

export type RunChat = (
  ctx: { supabase: unknown },
  opts: {
    useCase: string;
    userId: string | null;
    threadId: null;
    messageId: null;
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    structuredTool: { name: string; description: string; inputSchema: Readonly<Record<string, unknown>> };
    maxOutputTokens?: number;
    timeoutMs?: number;
  },
) => Promise<RunChatResult>;

let cachedRunChat: RunChat | null = null;

/**
 * Find the ai module's runner. Same candidate list as broadcasts: the
 * workspace package for dev, the sibling module in the clone tree the api
 * pod builds at boot (modules/social-posts/lib → modules/ai/lib), and the
 * source path for a side-by-side checkout.
 */
export async function loadRunChat(): Promise<RunChat> {
  if (cachedRunChat) return cachedRunChat;
  const attempts = [
    '@gatewaze-modules/ai/lib/runner.js',
    '../../ai/lib/runner.js',
    '../../../../gatewaze-modules/modules/ai/lib/runner.ts',
  ];
  const failures: string[] = [];
  for (const path of attempts) {
    try {
      const mod = (await import(/* @vite-ignore */ path)) as { runChat?: RunChat };
      if (typeof mod.runChat === 'function') {
        cachedRunChat = mod.runChat;
        return mod.runChat;
      }
      failures.push(`${path} (runChat is ${typeof mod.runChat})`);
    } catch (e) {
      failures.push(`${path} (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`);
    }
  }
  throw new Error(`@gatewaze-modules/ai runChat unavailable. Tried: ${failures.join('; ')}`);
}

export interface GenerateInput {
  platform: Platform;
  format: Format;
  items: PoolItem[];
  instructions: string | null;
  userId: string;
}

export interface GenerateResult extends FinishedPost {
  model: string | null;
  costMicroUsd: number;
}

export class GenerateError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GenerateError';
  }
}

/** Map a runChat failure to an HTTP status and a message safe to show an admin. */
export function classifyRunChatError(e: unknown): GenerateError {
  const err = e as { name?: string; message?: string; httpStatus?: number };
  const msg = String(err?.message ?? '');
  if (msg.startsWith('budget_exceeded') || /daily_call_cap/.test(msg)) {
    return new GenerateError("Today's AI budget for social posts is used up. Try again tomorrow, or raise the cap in Settings → AI.", 429, 'budget_exceeded', e);
  }
  if (err?.httpStatus === 429 || err?.name === 'ProviderRateLimitError') {
    return new GenerateError('The AI provider is rate-limiting requests. Try again in a minute.', 429, 'rate_limited', e);
  }
  if (err?.name === 'NoCredentialsError' || /no resolvable credentials|No credentials configured/.test(msg)) {
    return new GenerateError('No AI credentials are configured for social posts.', 503, 'ai_unavailable', e);
  }
  if (/not registered/.test(msg)) {
    return new GenerateError('The social-posts AI use case is not registered. Reinstall the module with the ai module enabled.', 503, 'ai_unavailable', e);
  }
  if (err?.name === 'ProviderTimeoutError') {
    return new GenerateError('The AI provider took too long. Try again.', 504, 'ai_timeout', e);
  }
  return new GenerateError('The AI provider returned an error. Try again.', 502, 'ai_error', e);
}

/**
 * One call, and one corrective retry when the answer has no text or runs
 * over the platform's limit. A second over-long answer is trimmed at a
 * paragraph break rather than failing the request.
 */
export async function generatePost(
  runChat: RunChat,
  supabase: unknown,
  input: GenerateInput,
): Promise<GenerateResult> {
  const platform = PLATFORMS[input.platform];
  const systemPrompt = buildSystemPrompt(input.platform, input.format);
  const userPrompt = buildUserPrompt(input.items, input.instructions);
  let costMicroUsd = 0;
  let model: string | null = null;

  const call = async (correction: string | null) => {
    let result: RunChatResult;
    try {
      result = await runChat({ supabase }, {
        useCase: platform.useCase,
        userId: input.userId,
        threadId: null,
        messageId: null,
        systemPrompt,
        messages: [{ role: 'user', content: correction ? `${userPrompt}\n\n${correction}` : userPrompt }],
        structuredTool: EMIT_POST_TOOL,
        maxOutputTokens: 2000,
        timeoutMs: 60_000,
      });
    } catch (e) {
      throw classifyRunChatError(e);
    }
    costMicroUsd += typeof result.costMicroUsd === 'number' ? result.costMicroUsd : 0;
    model = typeof result.model === 'string' ? result.model : model;
    return finishPost(result.structured, input.items, input.platform);
  };

  const problem = (out: Awaited<ReturnType<typeof call>>): string | null =>
    out.ok ? overLimit(out.post, input.platform) : out.error;

  let out = await call(null);
  const first = problem(out);
  if (first) {
    out = await call(`Your previous answer was not usable: ${first}. Call emit_post again with a corrected post${out.ok ? ` well under ${platform.targetChars} characters` : ''}.`);
  }
  if (!out.ok) {
    throw new GenerateError(`The AI could not write a usable post (${out.error}). Try again.`, 502, 'ai_bad_output');
  }
  // Still over the limit after the retry: cut at a paragraph break and say so.
  return { ...trimToLimit(out.post, input.platform), model, costMicroUsd };
}
