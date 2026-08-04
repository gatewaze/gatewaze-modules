/**
 * Strip inline text/background colour from pasted HTML for the newsletter
 * native richtext fields.
 *
 * Why this exists (issue #34): the newsletter block richtext fields register
 * TipTap's `TextStyle` + `@tiptap/extension-color` (to power the toolbar
 * colour picker in `richtext-menu.tsx`). Those extensions parse an inline
 * `color:` declaration out of pasted HTML into a `textStyle` colour mark.
 * External rich-text sources (web pages, Google Docs, …) routinely wrap body
 * text in `<span style="color:rgb(85,85,85)">`-style grey, so pasted text
 * kept that grey mark and rendered grey in the editor while the rendered
 * preview (which normalises to the block's black default) showed black.
 *
 * The fix runs at paste time only, via a ProseMirror `transformPastedHTML`
 * plugin wired onto `TextStyle` in `merge-into-config.tsx`. Removing the
 * inline colour BEFORE TipTap parses the pasted HTML means pasted text
 * carries no colour mark and inherits the editor default (black), matching
 * the preview — while directly-typed text, the toolbar colour picker
 * (applied AFTER paste), and previously-saved colours (parsed from the
 * STORED value, never through this path) all keep working.
 *
 * This helper is deliberately a pure string transform in its own module so
 * it unit-tests without the editor bundle (mirrors `rich-text.ts` /
 * `richtext-sanitize.ts`). It is intended to be called ONLY on pasted input,
 * never on stored values.
 */

/**
 * Inline-style declarations we drop. `color` is the #34 culprit; the
 * `background`/`background-color` pair covers pasted highlight fills that
 * would otherwise carry a stray fill into the email body.
 */
const STRIPPED_PROPS = new Set(['color', 'background-color', 'background']);

/**
 * Filter a `style` attribute VALUE (the text between the quotes), dropping
 * only colour/background declarations and preserving everything else exactly.
 * Declarations are split on `;` and matched by their property name (the text
 * before the first `:`), lower-cased and trimmed — so `Color: RGB( 85,85,85 )`
 * and messy spacing/casing are handled, and a value that merely contains the
 * word "color" (e.g. `background-image:url(color.png)`) is NOT matched
 * because the property name is what's compared.
 */
function filterStyleDeclarations(styleBody: string): string {
  return styleBody
    .split(';')
    .map((decl) => decl.trim())
    .filter((decl) => decl.length > 0)
    .filter((decl) => {
      const colon = decl.indexOf(':');
      if (colon === -1) return true; // malformed declaration — leave untouched
      const prop = decl.slice(0, colon).trim().toLowerCase();
      return !STRIPPED_PROPS.has(prop);
    })
    .join('; ');
}

/**
 * Remove `color` / `background` / `background-color` declarations from every
 * inline `style="…"` (or `style='…'`) attribute in `html`, leaving all other
 * markup and declarations untouched. A style attribute left empty after
 * filtering is removed entirely (along with its leading whitespace).
 *
 * Only the contents of `style` attributes are inspected, so non-style
 * occurrences of the word "color" (URLs, text) are never affected.
 */
export function stripPastedTextColors(html: string): string {
  if (!html) return html;
  return html.replace(
    /\s*style\s*=\s*(["'])([\s\S]*?)\1/gi,
    (_match, quote: string, styleBody: string) => {
      const filtered = filterStyleDeclarations(styleBody);
      return filtered === '' ? '' : ` style=${quote}${filtered}${quote}`;
    },
  );
}
