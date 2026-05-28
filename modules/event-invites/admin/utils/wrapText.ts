/**
 * Word-wrap a string into lines whose rendered width does not exceed
 * `maxWidth`. If `maxWidth` is falsy, the original text is returned as a
 * single line.
 *
 * The caller provides a `measureWidth` function, which lets the editor use
 * canvas.measureText and the PDF generator use pdf-lib's
 * `widthOfTextAtSize` — both measure the same font so the wrapping behaviour
 * is as consistent as reasonably possible between preview and output.
 *
 * Words longer than maxWidth are placed on their own line (no mid-word
 * breaking).
 */
export function wrapText(
  text: string,
  maxWidth: number | undefined,
  measureWidth: (s: string) => number,
): string[] {
  if (!maxWidth || maxWidth <= 0 || !text) return [text];

  // Preserve explicit newlines in the source text.
  const paragraphs = text.split(/\r?\n/);
  const out: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      out.push('');
      continue;
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word;
      if (measureWidth(trial) <= maxWidth) {
        line = trial;
      } else {
        if (line) out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }

  return out;
}
