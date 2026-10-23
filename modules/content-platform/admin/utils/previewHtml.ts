// dompurify, not isomorphic-dompurify: the admin build resolves module files
// with Node conditions, so isomorphic-dompurify gave its JSDOM (server) build,
// whose JSDOM is stubbed in the browser bundle, leaving `sanitize` undefined
// ("b.sanitize is not a function" on LF dev). dompurify is a direct admin
// dependency and builds its instance from the browser window. Depending on the
// CJS/ESM interop the instance is the default import or its `.default`.
import DOMPurifyImport from 'dompurify';

type Purifier = { sanitize: (html: string, cfg: Record<string, unknown>) => unknown };
const DOMPurify: Purifier = typeof (DOMPurifyImport as unknown as Purifier).sanitize === 'function'
  ? (DOMPurifyImport as unknown as Purifier)
  : (DOMPurifyImport as unknown as { default: Purifier }).default;

/** The tags a stored discovery body may contain (content-sources sanitizeBody's allow-list). */
const PREVIEW_TAGS = [
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
  'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'div',
];

/**
 * Sanitise a stored body for the Inbox drawer preview.
 *
 * The body was sanitised when it was stored, but it came from a third-party
 * page and the admin is a privileged origin, so it is sanitised again here
 * rather than trusted: an allow-list of tags, only href/title/src/alt
 * attributes (no data-* or aria-*), and only https: (or mailto: for links)
 * URLs. Links open in a new tab with no opener and no referrer; an image
 * without an absolute https source is dropped; images load lazily and send
 * no referrer.
 */
export function previewHtml(html: string | null | undefined): string {
  if (!html) return '';
  const frag = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: PREVIEW_TAGS,
    ALLOWED_ATTR: ['href', 'title', 'src', 'alt'],
    ALLOWED_URI_REGEXP: /^(?:https:|mailto:)/i,
    // DOMPurify keeps data-* and aria-* by default, separately from
    // ALLOWED_ATTR; third-party content gets neither in the admin DOM.
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  }) as unknown as DocumentFragment;
  frag.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer nofollow');
  });
  frag.querySelectorAll('img').forEach((img) => {
    if (!/^https:\/\//i.test(img.getAttribute('src') ?? '')) {
      img.remove();
      return;
    }
    img.setAttribute('loading', 'lazy');
    img.setAttribute('referrerpolicy', 'no-referrer');
  });
  const doc = frag.ownerDocument ?? document;
  const holder = doc.createElement('div');
  holder.appendChild(frag);
  return holder.innerHTML;
}

/** An absolute https URL, else null. The API already filters; this is the last check before an href or src. */
export function httpsOnly(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}
