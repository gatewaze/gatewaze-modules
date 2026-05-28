/**
 * PDF text extraction via pdf-parse (MIT). Images + layout discarded;
 * we only feed text to the LLM.
 */

// pdf-parse is CommonJS; the default export is the function.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import pdfParse from 'pdf-parse';

export async function parsePdf(buf: Buffer): Promise<
  | { ok: true; text: string; warnings: string[] }
  | { ok: false; reason: string }
> {
  try {
    const result = await pdfParse(buf);
    // result.text is plain text extracted from the PDF.
    // Strip multiple consecutive newlines (PDFs leak page breaks).
    const cleaned = result.text
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { ok: true, text: cleaned, warnings: [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('password')) {
      return { ok: false, reason: 'pdf_password_protected' };
    }
    return { ok: false, reason: `pdf_parse_failed: ${msg}` };
  }
}
