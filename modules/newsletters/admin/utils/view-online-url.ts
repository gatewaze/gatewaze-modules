/**
 * Compute the "View Online" URL for an edition — used by:
 *   - the editor preview / canvas render of the wrapper's
 *     `{{edition.view_online_link}}` field
 *   - the "Copy production HTML" export
 *   - the test-send and the real send flows
 *
 * The URL is taken from the newsletter's `view_online_target` setting:
 *
 *   `external`  →  `<view_online_external_base_url>/<edition-folder-slug>/`
 *                  (for newsletters published to a separate static host —
 *                   GitHub Pages, Netlify, etc.)
 *
 *   `portal`    →  `<portal-host>/newsletters/<collection-slug>/<edition-folder-slug>`
 *   (default)    (the brand's portal — derived from the current admin
 *                 hostname. The Helm-deployed brands serve the portal at
 *                 the apex, so `admin.` at the start of the hostname is
 *                 stripped (admin.aaif.live → aaif.live). Fly.io / preview
 *                 deployments using a `<brand>-admin.<host>` infix swap
 *                 to `<brand>-app.<host>` instead — see derivePortalOrigin
 *                 below for the full rules.)
 *
 * Returns `null` when the inputs aren't sufficient to produce a stable URL
 * yet (e.g. an edition without a date) — callers should fall back to the
 * `{{web_version}}` template token in that case so the send pipeline can
 * still substitute server-side.
 */
import { editionFolderSlug } from '../../lib/edition-slug.js';

export interface ViewOnlineCollection {
  slug?: string | null;
  view_online_target?: string | null;
  view_online_external_base_url?: string | null;
}

export interface ViewOnlineEdition {
  edition_date?: string | null;
  /** Either `subject` (newsletter send) or `title` (editor draft); the
   *  folder slug uses the first non-empty one. */
  subject?: string | null;
  title?: string | null;
}

/** Derive the brand's portal host from the current admin host.
 *
 *  The Helm-deployed brands (AAIF, AutoDB, …) serve the portal at the apex
 *  domain — there is no `app.<brand>.<tld>` ingress: the ingress is
 *  `admin.<brand>.<tld>` for admin and `<brand>.<tld>` for portal. So an
 *  `admin.` prefix at the START of the hostname is stripped:
 *    admin.aaif.live      → aaif.live
 *    admin.autodb.io      → autodb.io
 *    admin.aaif.localhost → aaif.localhost
 *
 *  Preview / dev hostnames that DON'T put admin at the front but use the
 *  `-admin` infix instead (Fly.io / Vercel preview convention,
 *  brand-admin.fly.dev) still swap to `-app.` — those deployments do have a
 *  separate `<brand>-app.<host>` portal.
 *
 *  Returns null when called in a non-browser context. */
function derivePortalOrigin(): string | null {
  if (typeof window === 'undefined') return null;
  const host = window.location.hostname.replace('-admin.', '-app.').replace(/^admin\./, '');
  return `${window.location.protocol}//${host}`;
}

export function getViewOnlineUrl(
  collection: ViewOnlineCollection | null | undefined,
  edition: ViewOnlineEdition | null | undefined,
): string | null {
  const date = edition?.edition_date?.slice(0, 10);
  if (!date) return null;
  const subject = (edition?.subject ?? edition?.title ?? '').trim();
  const folder = editionFolderSlug(date, subject);

  if (collection?.view_online_target === 'external') {
    const base = collection.view_online_external_base_url?.trim().replace(/\/+$/, '');
    if (!base) return null;
    return `${base}/${folder}/`;
  }

  const slug = collection?.slug?.trim();
  if (!slug) return null;
  const origin = derivePortalOrigin();
  if (!origin) return null;
  return `${origin}/newsletters/${slug}/${folder}`;
}
