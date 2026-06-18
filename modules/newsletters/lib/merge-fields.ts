/**
 * Merge-field substitution shared between the SEND pipeline (newsletter-send
 * Edge Function) and the PORTAL renderer (View Online / published edition
 * pages).
 *
 * Tokens look like:
 *
 *   {{first_name}}                   — substitutes the recipient's first name,
 *                                      or empty string when not available.
 *   {{first_name|there}}             — substitutes the recipient's first name,
 *                                      falling back to "there" when missing.
 *   {{first_name|"Hey friend"}}      — fallback can be quoted to preserve a
 *                                      leading/trailing space, e.g. " " or
 *                                      "Hey friend". Single or double quotes.
 *
 * On the SEND path, `attrs` is the recipient's people.attributes record
 * (which the send pipeline pre-fetches once per recipient). On the PORTAL
 * path there is no recipient — every viewer is anonymous — so callers pass
 * an empty attrs object, and the fallback in each token always wins. That's
 * exactly the behaviour the public View Online page wants: a personalised
 * email's `Hey {{first_name|"there"}}!` reads as `Hey there!` in the browser,
 * not `Hey {{first_name|"there"}}!` literal.
 *
 * `name` is computed as `${first_name} ${last_name}` (joined with a single
 * space, empty halves trimmed) so a wrapper template can use {{name}} without
 * the writer having to think about which subfields are present.
 *
 * `escape: true` (default) HTML-encodes the substituted value so a recipient
 * whose first name is `<script>` ends up as `&lt;script&gt;` in the body.
 * `escape: false` is for contexts where the surrounding renderer already
 * HTML-encodes (e.g. the subject line, or pre-escaped JSX text nodes).
 */

export const MERGE_FIELDS = ['first_name', 'last_name', 'name', 'company', 'job_title'] as const;
const MERGE_FIELD_GROUP = MERGE_FIELDS.join('|');
const MERGE_FIELD_RE = new RegExp(`\\{\\{\\s*(${MERGE_FIELD_GROUP})\\s*(?:\\|([^}]*))?\\}\\}`, 'g');

/** Quick predicate — does this string contain at least one merge token? */
export function htmlUsesMergeFields(html: string): boolean {
  return new RegExp(`\\{\\{\\s*(?:${MERGE_FIELD_GROUP})\\b`).test(html);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Fallback after `|` can be wrapped in matching single or double quotes to
 *  preserve a leading/trailing space — `{{first_name|"Dan the man"}}`. Strip
 *  one layer of matching quotes; otherwise trim. */
function unquoteFallback(fb: string): string {
  const t = fb.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

export function substituteMergeFields(text: string, attrs: Record<string, unknown>, escape = true): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
  return text.replace(MERGE_FIELD_RE, (_m, field: string, fallback?: string) => {
    let val: string;
    if (field === 'name') {
      val = [str(attrs.first_name), str(attrs.last_name)].filter(Boolean).join(' ');
    } else {
      val = str(attrs[field]);
    }
    if (!val) val = unquoteFallback(fallback ?? '');
    return escape ? escapeHtml(val) : val;
  });
}

/**
 * Walks a content tree (the JSON-ish object stored on
 * newsletters_edition_blocks.content / edition_bricks.content) and applies
 * `substituteMergeFields` to every string leaf. Returns a new object — the
 * input is not mutated.
 *
 * Used by the portal renderer to evaluate merge tokens BEFORE the declarative
 * renderer processes the content map (the declarative renderer's `{{X}}`
 * lookup is keyed on top-level field name, so `{{first_name|"there"}}` is
 * a single opaque key it can't resolve — without this pre-pass the literal
 * leaks into the rendered HTML).
 *
 * `escape` defaults to FALSE here because the declarative renderer's
 * richtext/text rendering already handles HTML safely — re-escaping at this
 * layer would double-escape the recipient's own legitimate HTML
 * (e.g. their first name's apostrophe rendered as `&amp;#39;`).
 */
export function substituteMergeFieldsInContent(
  content: unknown,
  attrs: Record<string, unknown>,
  escape = false,
): unknown {
  if (typeof content === 'string') {
    return substituteMergeFields(content, attrs, escape);
  }
  if (Array.isArray(content)) {
    return content.map((item) => substituteMergeFieldsInContent(item, attrs, escape));
  }
  if (content && typeof content === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(content as Record<string, unknown>)) {
      out[k] = substituteMergeFieldsInContent(v, attrs, escape);
    }
    return out;
  }
  return content;
}
