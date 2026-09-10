import DOMPurify from 'isomorphic-dompurify';

/**
 * Question text is authored in a rich-text field, so `question_text` holds
 * HTML ("<p style=\"text-align: left;\">Main Meal</p>"). Rich contexts render
 * it through DOMPurify; contexts that can only take a string — a table
 * heading, a CSV column, a `title` attribute — need it flattened first.
 *
 * Tags are stripped by DOMPurify rather than a regex so that entities are
 * handled too: a naive `/<[^>]*>/g` leaves "Fish &amp; Chips" reading
 * literally as "Fish &amp;amp; Chips" in a heading.
 */
export function questionPlainText(html: string | null | undefined): string {
  if (!html) return '';

  // Stripping tags outright would run consecutive blocks together
  // ("<p>Starter</p><p>Main</p>" → "StarterMain"), so mark the boundaries
  // with a space first. The collapse at the end tidies up the extras.
  const spaced = html.replace(/<\/(?:p|div|li|ul|ol|h[1-6]|blockquote|tr)>|<br\s*\/?>/gi, ' ');

  const stripped = DOMPurify.sanitize(spaced, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });

  // Decode entities left behind by the strip. A textarea parses its content as
  // character data, so nothing here can execute — and the tags are gone anyway.
  let decoded = stripped;
  if (typeof document !== 'undefined') {
    const el = document.createElement('textarea');
    el.innerHTML = stripped;
    decoded = el.value;
  }

  // Block tags become run-together whitespace once stripped.
  return decoded.replace(/\s+/g, ' ').trim();
}
