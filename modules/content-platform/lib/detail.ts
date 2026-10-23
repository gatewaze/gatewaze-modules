/**
 * Helpers for the Inbox detail route (`/api/admin/inbox/detail/...`).
 * Dependency-free so they can be unit-tested without the API's imports.
 */

export const DETAIL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DETAIL_CONTENT_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** Longest body the drawer preview is sent. Stored discovery bodies are capped at 200 KB. */
export const DETAIL_BODY_MAX = 250_000;

/**
 * An absolute https URL with no credentials, at most 2048 characters, else
 * null. The drawer puts these in an href and an img src, so a javascript:,
 * data: or http: value an adapter returns never reaches the page.
 */
export function httpsUrlOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const out = u.toString();
    return out.length <= 2048 ? out : null;
  } catch {
    return null;
  }
}

export interface InboxDetailPayload {
  url: string | null;
  image_url: string | null;
  body_html: string | null;
}

/** Shape what an adapter's inbox_detail_fn returned into what the drawer gets. */
export function shapeDetail(raw: unknown): InboxDetailPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  return {
    url: httpsUrlOrNull(d.url),
    image_url: httpsUrlOrNull(d.image_url),
    body_html: typeof d.body_html === 'string' && d.body_html.trim()
      ? d.body_html.slice(0, DETAIL_BODY_MAX)
      : null,
  };
}
