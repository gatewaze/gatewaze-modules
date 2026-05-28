/**
 * Plain-text passthrough. UTF-8 decode + strip control chars.
 */

export function parseTxt(buf: Buffer): { ok: true; text: string; warnings: string[] } | { ok: false; reason: string } {
  try {
    const text = buf.toString('utf-8');
    // Strip C0 controls except \t, \n, \r.
    const stripped = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    return { ok: true, text: stripped, warnings: [] };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
