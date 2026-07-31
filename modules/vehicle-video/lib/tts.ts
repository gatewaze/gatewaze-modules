/**
 * Gemini TTS (spec §6 Phase C). Synthesises the voiceover script via the Gemini
 * API (same Google AI key as Veo), returns WAV bytes. Gemini TTS returns raw PCM
 * (24kHz, 16-bit, mono); we prepend a 44-byte WAV header (idea Appendix C).
 */

import { requireGoogleKey } from './google-key.js';
import { VehicleVideoError } from './errors.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';

const KNOWN_VOICES = new Set([
  'Kore', 'Charon', 'Fenrir', 'Puck', 'Orus', 'Leda', 'Zephyr', 'Aoede',
]);

function resolveVoice(voice: string | undefined): string {
  return voice && KNOWN_VOICES.has(voice) ? voice : 'Charon';
}

export interface TtsOpts {
  /** A prebuilt Gemini voice name (Kore, Charon, …). Falls back to Charon. */
  voice?: string;
  /** Natural-language delivery instruction (accent, tone) — Gemini 2.5 TTS is
   *  prompt-steerable, so this prepends e.g. "Read in a warm North East England
   *  (Teesside) accent, unhurried:". The base voice is accent-neutral; the accent
   *  comes from here. */
  style?: string;
}

/** Synthesise text → WAV Buffer using the given voice + delivery style. */
export async function synthesize(text: string, opts: TtsOpts = {}): Promise<Buffer> {
  const key = requireGoogleKey();
  const url = `${API_BASE}/models/${TTS_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const styled = opts.style && opts.style.trim() ? `${opts.style.trim()}\n\n${text}` : text;
  const voice = opts.voice;
  const body = {
    contents: [{ parts: [{ text: styled }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: resolveVoice(voice) } },
      },
    },
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new VehicleVideoError('TTS_FAILED', 'finalize', `TTS network error: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new VehicleVideoError('TTS_FAILED', 'finalize', `TTS HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
  };
  const b64 = json.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) throw new VehicleVideoError('TTS_FAILED', 'finalize', 'TTS returned no audio');
  const pcm = Buffer.from(b64, 'base64');
  return pcmToWav(pcm, 24000, 1, 16);
}

/** Prepend a 44-byte WAV header to raw PCM (idea Appendix C). */
export function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitDepth = 16): Buffer {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
