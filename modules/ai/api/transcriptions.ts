/**
 * POST /api/ai/transcriptions — the one endpoint every mic button hits
 * (spec-ai-voice-transcription.md §3.2).
 *
 * multipart/form-data: `audio` (exactly one file, ≤5 MB), `use_case`,
 * `language?` (ISO-639-1). Response: { data: { text, durationSeconds } }.
 *
 * Every gate runs before a provider is touched: JWT, use-case existence +
 * modality, audience (a member JWT must not burn an admin use case's
 * budget), magic-byte MIME sniff, per-person rate limit. Audio is memory-
 * only — multer.memoryStorage, no disk path — and nothing of it reaches
 * logs or error strings.
 */

import { Router } from 'express';
import multer from 'multer';
import { requireJwt } from '../lib/require-jwt.js';
import { aiTranscribe } from '../lib/transcribe.js';
import { ProviderError, ProviderTimeoutError } from '../lib/providers/types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = { from(table: string): any };

const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
/** The body must fully arrive within this window (slowloris guard). */
const BODY_DEADLINE_MS = 30_000;

/** Magic-byte sniff for the allowlisted containers. Header is never trusted. */
function sniffAudioMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // EBML (webm)
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'audio/webm';
  // ISO BMFF: 'ftyp' at offset 4 AND an audio-plausible major_brand — a
  // bare ftyp check would wave through any .mp4 video or HEIC image into
  // the native decoder behind this endpoint.
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    const ok = ['M4A ', 'M4B ', 'mp41', 'mp42', 'isom', 'iso2', 'iso5', 'iso6', '3gp4', '3gp5'];
    return ok.includes(brand) ? 'audio/mp4' : null;
  }
  // RIFF....WAVE
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  // OggS
  if (buf.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  // MP3: ID3 tag or MPEG frame sync
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
  // Bare MPEG frame sync is trivially forgeable with two bytes — also
  // require valid version (not reserved 01) and layer (not reserved 00)
  // bits and a non-invalid bitrate index.
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0
    && (buf[1] & 0x18) !== 0x08
    && (buf[1] & 0x06) !== 0x00
    && (buf[2] & 0xf0) !== 0xf0) return 'audio/mpeg';
  return null;
}

export function mountTranscriptionRoutes(
  router: Router,
  deps: { supabase: SupabaseClient },
): void {
  const { supabase } = deps;

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 2, fieldSize: 1024 },
  });

  // Sliding-window per-person limiter; pruned on write so it can't grow
  // beyond the set of people active in the last minute.
  const windows = new Map<string, number[]>();
  const allow = (personKey: string): boolean => {
    const now = Date.now();
    const kept = (windows.get(personKey) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    for (const [k, v] of windows) {
      if (!v.length || now - v[v.length - 1]! >= RATE_WINDOW_MS) windows.delete(k);
    }
    if (kept.length >= RATE_MAX) { windows.set(personKey, kept); return false; }
    kept.push(now);
    windows.set(personKey, kept);
    return true;
  };

  router.post(
    '/transcriptions',
    requireJwt() as never,
    // Rate limit FIRST — before the 5 MB body is parsed, so malformed
    // requests still spend the caller's budget (security-review catch:
    // a limiter behind the expensive work never engages for requests
    // crafted to fail early).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req: any, res: any, next: any) => {
      if (!req.userId) {
        res.status(401).json({ error: { code: 'unauthorized', message: 'No session.' } });
        return;
      }
      if (!allow(String(req.userId))) {
        res.status(429).json({ error: { code: 'rate_limited', message: 'Too many voice notes at once — give it a few seconds.' } });
        return;
      }
      next();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req: any, res: any, next: any) => {
      // Slowloris guard: the whole body must land inside the deadline.
      const timer = setTimeout(() => { try { req.destroy(); } catch { /* closed */ } }, BODY_DEADLINE_MS);
      upload.single('audio')(req, res, (err: unknown) => {
        // The guard bounds the UPLOAD phase only — a transcription that
        // legitimately uses its full queue+inference budget must not have
        // its socket cut from under it (security-review catch).
        clearTimeout(timer);
        if (err) {
          const tooBig = (err as { code?: string })?.code === 'LIMIT_FILE_SIZE';
          res.status(tooBig ? 413 : 400).json({
            error: {
              code: tooBig ? 'too_large' : 'bad_request',
              message: tooBig ? 'Audio must be under 5 MB.' : 'Could not read the upload.',
            },
          });
          return;
        }
        next();
      });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (req: any, res: any) => {
      const fail = (status: number, code: string, message: string) =>
        res.status(status).json({ error: { code, message } });
      try {
        const userId: string | undefined = req.userId;
        if (!userId) return fail(401, 'unauthorized', 'No session.');

        const useCase = typeof req.body?.use_case === 'string' ? req.body.use_case : '';
        const language = typeof req.body?.language === 'string' ? req.body.language.toLowerCase() : '';
        if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(useCase)) {
          return fail(400, 'bad_request', 'use_case required.');
        }
        if (language && !/^[a-z]{2}$/.test(language)) {
          return fail(400, 'bad_request', 'language must be a two-letter ISO-639-1 code.');
        }
        const audio: Buffer | undefined = req.file?.buffer;
        if (!audio?.length) return fail(400, 'bad_request', 'No audio received.');

        const mime = sniffAudioMime(audio);
        if (!mime) return fail(400, 'bad_request', 'That does not look like a supported audio recording.');

        const uc = await supabase
          .from('ai_use_cases')
          .select('id, modality, audience')
          .eq('id', useCase)
          .maybeSingle();
        if (!uc.data || uc.data.modality !== 'transcription') {
          return fail(400, 'bad_request', 'Unknown transcription use case.');
        }
        if (uc.data.audience === 'admin') {
          const { data: admin } = await supabase
            .from('admin_profiles')
            .select('is_active')
            .eq('user_id', userId)
            .maybeSingle();
          if (!admin?.is_active) return fail(403, 'forbidden', 'Admin access required for this use case.');
        }
        const controller = new AbortController();
        req.on('close', () => { if (!res.writableEnded) controller.abort(); });

        const out = await aiTranscribe({ supabase }, {
          useCase,
          userId,
          audio,
          mimeType: mime,
          ...(language ? { language } : {}),
          signal: controller.signal,
        });

        if ((out.durationSeconds ?? out.estimatedSeconds) > 180) {
          return fail(413, 'too_large', 'Voice notes are capped at 3 minutes.');
        }
        if (out.silence) {
          return fail(422, 'unprocessable', "We couldn't hear anything in that recording.");
        }
        res.json({ data: { text: out.text, durationSeconds: out.durationSeconds } });
      } catch (err) {
        // Never echo provider errors: nothing of the audio or transcript may
        // leak through an error string.
        if (err instanceof ProviderTimeoutError) {
          return fail(503, 'ai_unavailable', 'Transcription timed out — try again.');
        }
        if (err instanceof ProviderError) {
          if (err.httpStatus === 429) return fail(429, 'rate_limited', 'Transcription is busy — try again shortly.');
          if (err.httpStatus === 499) return; // client went away; nothing to say
          return fail(503, 'ai_unavailable', 'Transcription is unavailable right now.');
        }
        console.warn(`[ai] transcription failed (${err instanceof Error ? err.name : 'Error'})`);
        return fail(503, 'ai_unavailable', 'Transcription is unavailable right now.');
      }
    },
  );
}
