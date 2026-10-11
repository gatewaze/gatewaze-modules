/**
 * The address of an album, and of the page it belongs to.
 *
 * /photos is the page; /photos/getting-ready is one of its albums. Moving
 * between albums rewrites that last part, and the address bar is what the
 * copy button hands over, so getting it wrong is visible immediately --
 * as it was: opening /photos/photo-booth wrote
 * /photos/photo-booth/photo-booth, because the album was appended to an
 * address that already named one (reported 2026-09-28).
 *
 * The cure is to stop reading the album back out of the bar. The page's
 * own address is worked out once, from the address it was opened at and
 * the album the portal says that address named, and everything is built
 * from that.
 */

/** The page's own address: what was opened, less the album it named. */
export function pageBaseFrom(pathname: string, pathAlbum?: string | null): string {
  const path = (pathname || '/').replace(/\/+$/, '') || ''
  if (!pathAlbum) return path || '/'
  const suffix = `/${pathAlbum}`
  return path.endsWith(suffix) ? (path.slice(0, -suffix.length) || '/') : (path || '/')
}

/** The address of one album of that page, or of the page itself. */
export function albumAddress(base: string, slug?: string | null): string {
  const root = base.replace(/\/+$/, '')
  return slug ? `${root}/${slug}` : (root || '/')
}
