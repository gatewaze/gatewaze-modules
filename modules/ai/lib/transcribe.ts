/**
 * aiTranscribe — the transcription runner entry point
 * (spec-ai-voice-transcription.md §3.1/§3.3b).
 *
 * Same seam contract as runChat: modules never construct provider clients
 * for audio themselves. Resolution:
 *   - model `whisper-local-*` → the OpenAI-shape client pointed at
 *     AI_TRANSCRIBE_BASE_URL (the in-cluster speaches/faster-whisper shim),
 *     authenticated with AI_TRANSCRIBE_SHARED_SECRET, model suffix passed
 *     through (`whisper-local-small` → `small`). No credential row needed.
 *   - anything else → normal ProviderRouter credential resolution (hosted
 *     OpenAI whisper-1 / gpt-4o-*-transcribe).
 *
 * Local calls run under a per-process semaphore (CPU-bound container), a
 * bounded wait queue, and a tiny circuit breaker; a use case may opt into a
 * hosted fallback via ai_use_cases.fallback_model (null = never leave our
 * infrastructure — the default).
 */

import { ProviderRouter, inferProvider } from './providers/router.js';
import { OpenAIProviderClient } from './providers/openai-client.js';
import {
  ProviderError,
  type TranscribeAudioResult,
} from './providers/types.js';
import { recordUsage } from './cost.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = { from(table: string): any };

const LOCAL_PREFIX = 'whisper-local-';
const QUEUE_WAIT_MS = 15_000;
const LOCAL_TIMEOUT_MS = 12_000;
const HOSTED_TIMEOUT_MS = 30_000;
const MAX_WAITERS = 10;
const CIRCUIT_OPEN_MS = 15_000;
const CIRCUIT_TRIP_AFTER = 3;

/** $/1M seconds → micro-USD per second. whisper-local costs nothing. */
const PRICE_MICRO_USD_PER_SECOND: Record<string, number> = {
  'whisper-1': 100,                 // $0.006/min
  'gpt-4o-transcribe': 100,
  'gpt-4o-mini-transcribe': 50,     // $0.003/min
};

export interface AiTranscribeOpts {
  useCase: string;
  userId: string | null;
  audio: Buffer;
  /** Sniffed MIME, never the client's header. */
  mimeType: string;
  language?: string;
  signal?: AbortSignal;
}

export interface AiTranscribeResult {
  text: string;
  durationSeconds: number | null;
  provider: 'openai';
  model: string;
  costMicroUsd: number;
  latencyMs: number;
  /** True when every verbose_json segment said no-speech (caller → 422). */
  silence: boolean;
  fallbackUsed: boolean;
  /** Size-derived duration floor, for cap checks when the model reports none. */
  estimatedSeconds: number;
}

// ── Per-process semaphore + circuit for the local container ────────────────

let localInFlight = 0;
let localWaiters = 0;
let consecutiveLocalFailures = 0;
let circuitOpenUntil = 0;

const capNum = (v: string | undefined, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

async function acquireLocalSlot(signal?: AbortSignal): Promise<() => void> {
  const limit = capNum(process.env.AI_TRANSCRIBE_MAX_CONCURRENT, 2);
  if (localInFlight < limit) {
    localInFlight += 1;
    return () => { localInFlight -= 1; };
  }
  if (localWaiters >= MAX_WAITERS) {
    throw new ProviderError('transcription queue is full', 'openai', 429, true);
  }
  localWaiters += 1;
  const started = Date.now();
  try {
    // Poll-based wait: simple, abort-aware, and good enough at ≤10 waiters.
    while (Date.now() - started < QUEUE_WAIT_MS) {
      if (signal?.aborted) {
        throw new ProviderError('client went away while queued', 'openai', 499, false);
      }
      if (localInFlight < limit) {
        localInFlight += 1;
        return () => { localInFlight -= 1; };
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new ProviderError('transcription queue wait timed out', 'openai', 429, true);
  } finally {
    localWaiters -= 1;
  }
}

function localCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

function noteLocalResult(ok: boolean, httpStatus: number): void {
  // A 4xx is the caller's fault, not the container's — never trips the circuit.
  if (ok || (httpStatus >= 400 && httpStatus < 500)) {
    consecutiveLocalFailures = 0;
    circuitOpenUntil = 0;
    return;
  }
  consecutiveLocalFailures += 1;
  if (consecutiveLocalFailures >= CIRCUIT_TRIP_AFTER) {
    circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
  }
}

// ── Entry point ────────────────────────────────────────────────────────────

export async function aiTranscribe(
  ctx: { supabase: SupabaseClient },
  opts: AiTranscribeOpts,
): Promise<AiTranscribeResult> {
  const row = await ctx.supabase
    .from('ai_use_cases')
    .select('id, default_model, allowed_models, fallback_model, modality, daily_call_cap')
    .eq('id', opts.useCase)
    .maybeSingle();
  if (row.error) throw new Error(`use_case lookup: ${row.error.message}`);
  if (!row.data) throw new Error(`use_case '${opts.useCase}' not registered`);
  if (row.data.modality !== 'transcription') {
    throw new ProviderError(`use_case '${opts.useCase}' is not a transcription use case`, 'openai', 400, false);
  }

  const model: string = row.data.default_model;
  const started = Date.now();
  const isLocal = model.startsWith(LOCAL_PREFIX);

  let result: TranscribeAudioResult | null = null;
  let servedBy = model;
  let fallbackUsed = false;

  const runHosted = async (hostedModel: string): Promise<TranscribeAudioResult> => {
    const router = new ProviderRouter(ctx.supabase);
    const picked = await router.pickClient({
      useCase: opts.useCase,
      userId: opts.userId,
      provider: 'openai',
      model: hostedModel,
      systemRunOnly: false,
    });
    if (!picked.client.transcribeAudio) {
      throw new ProviderError('provider does not support transcription', 'openai', 500, false);
    }
    return picked.client.transcribeAudio({
      audio: opts.audio,
      mimeType: opts.mimeType,
      model: hostedModel,
      ...(opts.language ? { language: opts.language } : {}),
      timeoutMs: HOSTED_TIMEOUT_MS,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  };

  if (isLocal) {
    const baseUrl = process.env.AI_TRANSCRIBE_BASE_URL?.replace(/\/$/, '');
    const sharedSecret = process.env.AI_TRANSCRIBE_SHARED_SECRET;
    const fallback: string | null = row.data.fallback_model ?? null;
    // A configured base URL with no shared secret is a misconfiguration, not
    // a reason to invent a credential (CLAUDE.md: no env||literal fallbacks).
    const localDown = !baseUrl || !sharedSecret || localCircuitOpen();
    if (localDown) {
      if (!fallback) {
        throw new ProviderError(
          !baseUrl ? 'AI_TRANSCRIBE_BASE_URL is not configured'
            : !sharedSecret ? 'AI_TRANSCRIBE_SHARED_SECRET is not configured'
              : 'local transcription is temporarily unavailable',
          'openai', 503, true,
        );
      }
      result = await runHosted(fallback);
      servedBy = fallback;
      fallbackUsed = true;
    } else {
      const release = await acquireLocalSlot(opts.signal);
      try {
        const client = new OpenAIProviderClient(sharedSecret!, baseUrl);
        // speaches/faster-whisper address models by HF repo id, so
        // `whisper-local-small` → `Systran/faster-whisper-small` by default;
        // deployments running other weights override the prefix.
        const localModelPrefix = process.env.AI_TRANSCRIBE_LOCAL_MODEL_PREFIX
          ?? 'Systran/faster-whisper-';
        result = await client.transcribeAudio!({
          audio: opts.audio,
          mimeType: opts.mimeType,
          model: `${localModelPrefix}${model.slice(LOCAL_PREFIX.length)}`,
          ...(opts.language ? { language: opts.language } : {}),
          timeoutMs: LOCAL_TIMEOUT_MS,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        noteLocalResult(true, 200);
      } catch (err) {
        if (opts.signal?.aborted) {
          // The caller went away — that says nothing about the container's
          // health, and letting it trip the shared circuit would let any
          // member 503 the whole pod with three cancelled taps.
          throw new ProviderError('client went away mid-transcription', 'openai', 499, false);
        }
        const status = err instanceof ProviderError ? err.httpStatus : 0;
        noteLocalResult(false, status);
        if (fallback && (status === 0 || status >= 500)) {
          result = await runHosted(fallback);
          servedBy = fallback;
          fallbackUsed = true;
        } else {
          throw err;
        }
      } finally {
        release();
      }
    }
  } else {
    result = await runHosted(model);
    servedBy = model;
  }

  const latencyMs = Date.now() - started;
  const probs = result.noSpeechProbs;
  const silence = (result.durationSeconds != null && result.durationSeconds < 1)
    || !result.text.trim()
    || (probs.length > 0 && probs.every((p) => p > 0.6));

  const perSecond = PRICE_MICRO_USD_PER_SECOND[servedBy] ?? 0;
  // ~32 kbps floor when the model reports nothing (gpt-4o-* can't return
  // verbose_json) — also handed to the caller so the duration cap still
  // has SOMETHING to bite on for those models.
  const estimatedSeconds = Math.ceil(opts.audio.length / 4000);
  const billedSeconds = result.durationSeconds ?? estimatedSeconds;
  const costMicroUsd = Math.round(perSecond * billedSeconds);

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordUsage(ctx.supabase as any, {
      userId: opts.userId,
      useCase: opts.useCase,
      threadId: null,
      messageId: null,
      kind: 'transcription',
      provider: inferProvider(servedBy) ?? 'openai',
      model: servedBy,
      latencyMs,
      status: 'ok',
      error: null,
      costMicroUsdOverride: costMicroUsd,
      bytesIn: opts.audio.length,
      mediaSeconds: result.durationSeconds ?? null,
    });
  } catch { /* ledger is best-effort; the reply still matters more */ }

  return {
    text: result.text,
    durationSeconds: result.durationSeconds,
    provider: 'openai',
    model: servedBy,
    costMicroUsd,
    latencyMs,
    silence,
    fallbackUsed,
    estimatedSeconds,
  };
}
