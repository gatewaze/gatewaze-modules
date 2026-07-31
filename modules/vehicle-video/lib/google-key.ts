/**
 * Resolve the Google AI (Gemini API) key used for Veo + Gemini TTS. Veo runs via
 * the Gemini API path (generativelanguage.googleapis.com), which uses the same
 * Google AI key as Gemini image/TTS — not a separate Veo domain/key (spec §8/§10.5).
 * Resolution order mirrors the ai module's gemini-client.
 */
export function resolveGoogleKey(): string | null {
  return (
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    null
  );
}

export function requireGoogleKey(): string {
  const key = resolveGoogleKey();
  if (!key) {
    throw new Error('GEMINI_API_KEY / GOOGLE_API_KEY not set — Veo + Gemini TTS unavailable');
  }
  return key;
}
