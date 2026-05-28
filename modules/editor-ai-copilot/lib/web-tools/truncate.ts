/**
 * UTF-8-safe byte truncation. Spec §3.2.1.
 *
 * Walks backward from `maxBytes` until we hit a code-point start so
 * we never split a multi-byte character. Appends a plain-text marker
 * so the model reads it as content and knows the page was truncated.
 */

const TRUNCATION_MARKER = '\n\n[...truncated by fetch_url_max_bytes limit]';

export function truncateToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;

  // Walk backward to the nearest code-point boundary. UTF-8 continuation
  // bytes are 0b10xxxxxx — leading bytes are not.
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut]! & 0b1100_0000) === 0b1000_0000) {
    cut--;
  }
  const decoder = new TextDecoder();
  return decoder.decode(bytes.subarray(0, cut)) + TRUNCATION_MARKER;
}

export const TRUNCATION_MARKER_TEXT = TRUNCATION_MARKER;
