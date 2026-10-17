/**
 * What a saved photograph is called on the way to somebody's phone.
 *
 * The stored object's own name is the best answer where there is one: a
 * photographer's delivery is named by the clock it was taken at
 * (`204742-alt03092-2.jpg`), which is far more use in a camera roll than
 * a uuid. Everything else falls back to the media id.
 *
 * The name reaches `a.download` and a `File`, so it is rebuilt from a
 * known-safe alphabet rather than passed through. Browsers do sanitise
 * it, but a name is not the place to find out whose sanitiser is in
 * charge -- a segment of `..` or a separator has no business in a
 * filename this code chose.
 */

/** Extensions worth keeping. Anything else is saved as a .jpg. */
const KEEP = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'mp4', 'mov', 'webm'])

const MAX_STEM = 60

/** The last path segment of a url, without its query or fragment. */
function lastSegment(url: string): string {
  // Not `new URL(...)`: this also has to cope with a bare path, and a
  // throw here would lose the download over a cosmetic detail.
  //
  // The authority has to come off first. Without that, a url with no
  // path -- `https://cdn/` -- hands back `cdn`, and the photograph saves
  // itself named after the CDN.
  const authority = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/.exec(url)
  const path = (authority ? url.slice(authority[0].length) : url).split(/[?#]/)[0] ?? ''
  const seg = path.split('/').filter(Boolean).pop() ?? ''
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

/** Only letters, digits, dot, dash and underscore survive. */
function clean(text: string): string {
  return text
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    // No leading dots, so nothing becomes a hidden file or a `..`.
    .replace(/^[.-]+/, '')
    .replace(/-+/g, '-')
    .replace(/-+$/, '')
}

export function saveNameOf(url: string, photo: { id?: string | null } = {}): string {
  const raw = lastSegment(url)
  const dot = raw.lastIndexOf('.')
  const rawExt = dot > 0 ? raw.slice(dot + 1).toLowerCase() : ''
  const ext = KEEP.has(clean(rawExt)) ? clean(rawExt) : 'jpg'
  const stem = clean(dot > 0 ? raw.slice(0, dot) : raw).slice(0, MAX_STEM)
  if (stem) return `${stem}.${ext}`
  const id = clean(String(photo.id ?? '')).slice(0, MAX_STEM)
  return `photo${id ? `-${id}` : ''}.${ext}`
}
