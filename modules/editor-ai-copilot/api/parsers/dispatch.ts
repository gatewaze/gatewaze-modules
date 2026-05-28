/**
 * Parser dispatcher — picks the right parser based on mime type +
 * filename hint. Mime is the primary signal (per spec §0000000a
 * sniff Content-Type, not URL extension).
 */

import { parsePdf } from './pdf-parser.js';
import { parseDocx } from './docx-parser.js';
import { parseMarkdown } from './markdown-parser.js';
import { parseTxt } from './txt-parser.js';
import { parseHtml } from './html-parser.js';

export type ParserResult =
  | { ok: true; text: string; warnings: string[]; format: string }
  | { ok: false; reason: string };

export async function parseDocument(
  buf: Buffer,
  mimeType: string,
  opts?: { filename?: string; sourceUrl?: string },
): Promise<ParserResult> {
  const mime = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  const filename = (opts?.filename ?? '').toLowerCase();

  if (mime === 'application/pdf' || filename.endsWith('.pdf')) {
    const r = await parsePdf(buf);
    return r.ok ? { ...r, format: 'pdf' } : r;
  }
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    filename.endsWith('.docx')
  ) {
    const r = await parseDocx(buf);
    return r.ok ? { ...r, format: 'docx' } : r;
  }
  if (mime === 'text/markdown' || filename.endsWith('.md') || filename.endsWith('.markdown')) {
    const r = parseMarkdown(buf);
    return r.ok ? { ...r, format: 'markdown' } : r;
  }
  if (mime === 'text/html' || mime === 'application/xhtml+xml') {
    const r = parseHtml(buf, opts);
    return r.ok ? { ...r, format: 'html' } : r;
  }
  if (mime === 'text/plain' || filename.endsWith('.txt')) {
    const r = parseTxt(buf);
    return r.ok ? { ...r, format: 'txt' } : r;
  }
  return { ok: false, reason: `document_unsupported_type: ${mime || 'unknown'}` };
}
