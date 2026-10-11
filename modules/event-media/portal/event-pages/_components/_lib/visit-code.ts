/**
 * Which half of /photos a visitor is asking for.
 *
 * The upload app and the photo booth belong to a visit that arrived
 * with an upload code on the address: ?u=<code>, as the QR short link
 * hands it over. Everyone else gets the albums. A code left in this
 * phone's localStorage from a previous visit is deliberately not
 * enough -- it used to be, and it put every guest who had ever scanned
 * the QR back into the guest app for ever.
 *
 * The address is the whole of the answer, on every render. The booth's
 * own history entries are pushed with no URL, so they keep whatever is
 * already in the address bar and cannot drop a guest out of the app
 * mid-photograph; a navigation that takes the code off the address is
 * somebody asking for the albums, and gets them.
 */

/** A link's short code, as an address is allowed to spell it. */
const CODE = /^[a-z0-9]{6,16}$/;

/**
 * The upload code a query string carries, or null.
 *
 * Takes the query string rather than a parsed value so the rule can be
 * read -- and tested -- against the addresses guests actually open.
 * A leading "?" is optional.
 */
export function uploadCodeOf(search: string | null | undefined): string | null {
  if (!search) return null;
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('u');
  } catch {
    return null;
  }
  return raw && CODE.test(raw) ? raw : null;
}
