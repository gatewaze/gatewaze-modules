/**
 * Question text is authored in a rich-text field, so `question_text` holds
 * HTML ("<p style=\"text-align: left;\">Main Meal</p>"). Rich contexts render
 * it through DOMPurify; contexts that can only take a string — a table
 * heading, a CSV column, a `title` attribute — need it flattened first.
 *
 * This deliberately does NOT use DOMPurify. Sanitising is for HTML you intend
 * to render; here every tag is discarded, so the browser's own parser is both
 * sufficient and safer. `DOMParser` with 'text/html' builds an inert document:
 * scripts do not run and no resource is fetched. It also avoids a bare
 * dependency import, which is what broke this helper in the admin module
 * bundle — `isomorphic-dompurify` resolved to a shape without `.sanitize`.
 */
/**
 * Remove markup without a regex. Tracking `<`/`>` depth means nested or
 * malformed forms like "<scr<script>ipt>" cannot leave a live tag behind,
 * which a `/<[^>]*>/g` strip does — that is a known-bad tag filter, and one
 * CodeQL rightly rejects.
 */
function stripTags(input: string): string {
  let out = '';
  let depth = 0;
  for (const ch of input) {
    if (ch === '<') depth++;
    else if (ch === '>') { if (depth > 0) depth--; }
    else if (depth === 0) out += ch;
  }
  return out;
}

export function questionPlainText(html: string | null | undefined): string {
  if (!html) return '';

  // Discarding tags outright would run consecutive blocks together
  // ("<p>Starter</p><p>Main</p>" → "StarterMain"), so mark the boundaries
  // with a space first. The collapse at the end tidies up the extras.
  const spaced = html.replace(/<\/(?:p|div|li|ul|ol|h[1-6]|blockquote|tr)>|<br\s*\/?>/gi, ' ');

  // No DOM (SSR, tests): scan the markup out by hand. Entities survive, which
  // is cosmetic — every caller of this helper runs in the browser.
  if (typeof DOMParser === 'undefined') {
    return stripTags(spaced).replace(/\s+/g, ' ').trim();
  }

  const doc = new DOMParser().parseFromString(spaced, 'text/html');

  // textContent includes the *source text* of script and style elements, so
  // drop those nodes rather than flattening their contents into the heading.
  doc.body.querySelectorAll('script, style, noscript, template').forEach((el) => el.remove());

  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}
