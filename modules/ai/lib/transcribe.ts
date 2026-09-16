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

/**
 * The self-hosted model families, by the alias a use case names them with.
 *
 * `whisper-local-*` was the only one, back when self-hosted meant Whisper. It
 * no longer does: a transducer like Parakeet is several times faster on the
 * same hardware and, because it can emit a blank, it stays quiet on silence
 * instead of inventing speech there. Calling that "whisper-local" in the
 * config and in the usage ledger would be recording something untrue about
 * what actually ran.
 *
 * The alias determines only which repository the suffix is resolved against.
 * Every family speaks the OpenAI audio API, so the calling code below is the
 * same for all of them.
 */
const LOCAL_FAMILIES = [
  {
    alias: 'whisper-local-',
    env: 'AI_TRANSCRIBE_LOCAL_MODEL_PREFIX',
    fallback: 'Systran/faster-whisper-',
  },
  {
    alias: 'parakeet-local-',
    env: 'AI_TRANSCRIBE_PARAKEET_MODEL_PREFIX',
    fallback: 'mlx-community/parakeet-tdt-0.6b-',
  },
] as const;

/** The family a use case's model belongs to, or null when it is hosted. */
function localFamily(model: string) {
  return LOCAL_FAMILIES.find((f) => model.startsWith(f.alias)) ?? null;
}

/** `parakeet-local-v2` → `mlx-community/parakeet-tdt-0.6b-v2`. */
function resolveLocalModel(model: string): string {
  const family = localFamily(model);
  if (!family) return model;
  const prefix = process.env[family.env] ?? family.fallback;
  return `${prefix}${model.slice(family.alias.length)}`;
}
/**
 * How long a queued request waits for a slot.
 *
 * Longer than it was, because a slot is now held for as long as the audio in
 * it needs rather than a flat twelve seconds. A waiter that gives up while the
 * request ahead of it is halfway through a two-minute note has not learned
 * that we are overloaded, only that somebody else got there first.
 */
const QUEUE_WAIT_MS = 30_000;
const HOSTED_TIMEOUT_MS = 30_000;
const MAX_WAITERS = 10;
const CIRCUIT_OPEN_MS = 15_000;
const CIRCUIT_TRIP_AFTER = 3;

// ── How long local inference is given ──────────────────────────────────────
//
// This WAS a flat 12s, which is not a timeout so much as an undocumented cap
// on how long a voice note may be. Whisper's inference time scales with the
// length of the audio, so a fixed budget silently sets a maximum duration —
// and on the staging CPU box that maximum was about fifteen seconds of speech.
// Members recorded forty seconds, waited, and were told transcription was
// unavailable. Measured there: a 38s note takes 29s, a ratio of about 0.8.
//
// The budget is therefore derived from how much audio was sent. It is a
// timeout, not a quota, so every estimate below deliberately errs high: being
// generous costs a slot held slightly too long, being mean rejects work that
// would have succeeded, which is the failure we are fixing.
const LOCAL_BASE_TIMEOUT_MS = 12_000;
/** ~2x the 0.8 ratio measured on CPU, so a slower box or a bigger model fits. */
const LOCAL_MS_PER_AUDIO_SECOND = 1_600;
/**
 * Nothing waits longer than this, whatever the arithmetic says. A container
 * that has wedged must not pin a slot indefinitely, and a member watching a
 * spinner has given up long before four minutes.
 */
const LOCAL_TIMEOUT_CEILING_MS = 240_000;
/** Used when a use case sets no cap of its own; mirrors the route's default. */
const DEFAULT_CAP_SECONDS = 180;
/**
 * Bytes per second of audio, at the LOWEST bitrate each container is plausibly
 * carrying. Dividing by a low figure over-estimates the duration, which is the
 * safe direction here.
 *
 * Decoding the real duration would be exact, but it means an ISO-BMFF box walk
 * for m4a and an EBML one for webm, on untrusted bytes, before we have decided
 * we even want the file. The estimate is bounded by the use case's own cap
 * below, so the worst a bad guess can do is hand back the ceiling.
 */
const MIN_BYTES_PER_AUDIO_SECOND: Record<string, number> = {
  'audio/mp4': 8_000,     // iOS records AAC ~128 kbps; 64 kbps floor
  'audio/mpeg': 8_000,
  'audio/webm': 2_000,    // browser Opus is far smaller, ~24-32 kbps
  'audio/ogg': 2_000,
  'audio/wav': 32_000,    // uncompressed, so size tells us almost exactly
};
const FALLBACK_BYTES_PER_AUDIO_SECOND = 2_000;

/**
 * The inference budget for one local call, from the size of the audio and the
 * longest recording this use case accepts.
 */
function localTimeoutMs(bytes: number, mimeType: string, capSeconds: number): number {
  const perSecond = MIN_BYTES_PER_AUDIO_SECOND[mimeType] ?? FALLBACK_BYTES_PER_AUDIO_SECOND;
  // Clamped to the cap: audio longer than that is refused after transcription
  // anyway, so there is nothing to be gained by budgeting beyond it.
  const seconds = Math.min(capSeconds, Math.ceil(bytes / perSecond));
  return Math.min(
    LOCAL_TIMEOUT_CEILING_MS,
    LOCAL_BASE_TIMEOUT_MS + seconds * LOCAL_MS_PER_AUDIO_SECOND,
  );
}

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

/**
 * Whisper's repetition hallucination, which the no-speech gate does not catch.
 *
 * Given quiet, noisy or clipped audio the model can fall into a loop and emit
 * one short phrase over and over, often having guessed the wrong language on
 * the way in. A member reported a text box filled with "meddwl i'r meddwl i'r
 * meddwl i'r…" — Welsh, from an English speaker, several hundred characters of
 * it. It is confident output, so every no_speech_prob is LOW and the existing
 * gate waves it through.
 *
 * Detected by how little the text says rather than by matching phrases: a
 * genuine sentence does not consist of one or two distinct words repeated
 * dozens of times. Deliberately narrow, because the cost of a false positive
 * is telling somebody we could not hear them when we could. It needs a long
 * transcript AND almost no variety in it, which ordinary speech never is,
 * including "no no no no" and someone counting reps.
 */
export function isRepetitionLoop(text: string): boolean {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length < 30) return false;
  const distinct = new Set(words).size;
  // 30+ words carrying fewer than 5 distinct ones is not a sentence.
  return distinct <= 4 || distinct / words.length < 0.08;
}

// ── Entry point ────────────────────────────────────────────────────────────

export async function aiTranscribe(
  ctx: { supabase: SupabaseClient },
  opts: AiTranscribeOpts,
): Promise<AiTranscribeResult> {
  const row = await ctx.supabase
    .from('ai_use_cases')
    .select('id, default_model, allowed_models, fallback_model, modality, daily_call_cap, max_media_seconds')
    .eq('id', opts.useCase)
    .maybeSingle();
  if (row.error) throw new Error(`use_case lookup: ${row.error.message}`);
  if (!row.data) throw new Error(`use_case '${opts.useCase}' not registered`);
  if (row.data.modality !== 'transcription') {
    throw new ProviderError(`use_case '${opts.useCase}' is not a transcription use case`, 'openai', 400, false);
  }

  const model: string = row.data.default_model;
  const started = Date.now();
  const isLocal = localFamily(model) !== null;

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
        // Self-hosted backends address models by repo id, so the use case's
        // alias is resolved against its family's prefix: `whisper-local-small`
        // → `Systran/faster-whisper-small`, `parakeet-local-v2` →
        // `mlx-community/parakeet-tdt-0.6b-v2`. Deployments running other
        // weights override the prefix per family.
        result = await client.transcribeAudio!({
          audio: opts.audio,
          mimeType: opts.mimeType,
          model: resolveLocalModel(model),
          ...(opts.language ? { language: opts.language } : {}),
          timeoutMs: localTimeoutMs(
            opts.audio.length,
            opts.mimeType,
            Number(row.data.max_media_seconds) || DEFAULT_CAP_SECONDS,
          ),
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
    || (probs.length > 0 && probs.every((p) => p > 0.6))
    || isRepetitionLoop(result.text);

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
