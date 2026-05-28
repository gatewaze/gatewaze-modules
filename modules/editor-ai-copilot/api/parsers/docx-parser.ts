/**
 * DOCX text extraction via mammoth (MIT). Strips OLE objects and
 * macros at extraction time (mammoth's behaviour by default).
 */

import mammoth from 'mammoth';

export async function parseDocx(buf: Buffer): Promise<
  | { ok: true; text: string; warnings: string[] }
  | { ok: false; reason: string }
> {
  try {
    const result = await mammoth.extractRawText({ buffer: buf });
    const warnings = (result.messages ?? [])
      .filter((m) => m.type === 'warning' || m.type === 'error')
      .map((m) => `docx_${m.type}: ${m.message}`);
    return { ok: true, text: result.value.trim(), warnings };
  } catch (err) {
    return { ok: false, reason: `docx_parse_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
