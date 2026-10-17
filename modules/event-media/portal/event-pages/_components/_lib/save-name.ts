/**
 * Keeping a photograph: what it is called, what type it carries, and
 * when it is too big to hold in memory at all.
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

/**
 * The types a saved file may carry, and the extension each one gets.
 *
 * The same lists as `PHOTO_MIME_ALLOWLIST` and `VIDEO_MIME_ALLOWLIST` in
 * lib/guest-limits.ts, written out again rather than imported: that
 * module imports `node:crypto` at the top, so pulling it into a portal
 * bundle breaks the build. Keep the two in step.
 *
 * It matters because the type comes off a CDN response header and ends
 * up on a File handed to the OS share sheet. Uploads are allowlisted at
 * the door and `completeUploads` refuses a stored Content-Type that
 * disagrees with the minted one, but enhanced copies and booth selfies
 * are written by server code that check does not cover.
 */
export const SAVE_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
}

/**
 * The most we will pull into memory to save it.
 *
 * `blob()` holds the whole object at once, and a guest upload link allows
 * a video of up to two gigabytes by default (migration 003). Buffering
 * that on a phone crashes the tab, so anything bigger is opened instead
 * and left to the browser, which streams it.
 */
export const MAX_SAVE_BYTES = 64 * 1024 * 1024

/** Extensions worth keeping from a url. Anything else is saved as a .jpg. */
const KEEP = new Set(Object.values(SAVE_TYPES).concat(['jpeg', 'avif']))

const MAX_STEM = 60

/**
 * Names Windows refuses whatever the extension, which a download would
 * silently fail on rather than report.
 */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/** Only a url the browser should ever be pointed at. */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/**
 * Should saving go to the OS share sheet, or straight to a download?
 *
 * The share sheet is how a picture reaches the camera roll on a phone,
 * where a download lands in Files and nobody finds it again. On a
 * desktop it is the wrong answer entirely: somebody clicking a download
 * button wants a file in Downloads, not a menu of apps to send it to.
 *
 * `navigator.canShare({ files })` does NOT tell the two apart -- macOS
 * Safari answers true and then opens the Mac share sheet, which is
 * exactly what Dan saw on 2026-10-17. What separates them is the
 * pointer: a phone and a tablet are coarse, a mouse and a trackpad are
 * fine. So both have to agree before the sheet is used.
 */
export function prefersShareSheet(canShare: boolean, coarsePointer: boolean): boolean {
  return Boolean(canShare) && Boolean(coarsePointer)
}

/**
 * The same object, fetched from the bucket instead of the CDN.
 *
 * Bunny Optimizer recompresses what it serves. Measured on one of Paul's
 * photographs on 2026-10-17: 3,031,246 bytes in the bucket, 1,478,272
 * through the zone, at identical pixel dimensions -- so it is quality
 * thrown away, not size. On screen that is the right trade and it is why
 * the zone is there. For something somebody is going to keep or print it
 * is not, so saving goes to the origin (asked 2026-10-17).
 *
 * The two urls differ only in their prefix (`browserObjectUrl` in
 * lib/cdn.ts builds both from one relative path), so this swaps that
 * prefix rather than reassembling anything. A url that does not start
 * with the zone is left exactly as it is: there is nothing to swap, and
 * guessing would be how a download starts pointing at the wrong host.
 *
 * Any `?width=`/`?quality=` is dropped with it, since that is the
 * Optimizer's resize and the point here is the object as stored.
 */
export function fullSizeUrl(
  url: string,
  cdnOrigin: string | null | undefined,
  objectOrigin: string | null | undefined,
): string {
  if (!isHttpUrl(url) || !cdnOrigin || !objectOrigin) return url
  const zone = cdnOrigin.replace(/\/+$/, '')
  const origin = objectOrigin.replace(/\/+$/, '')
  if (!isHttpUrl(zone) || !isHttpUrl(origin)) return url
  if (url !== zone && !url.startsWith(`${zone}/`)) return url
  return `${origin}${url.slice(zone.length).split('?')[0]}`
}

/**
 * An allowlisted media type for this blob, or null to leave it unset.
 *
 * Null rather than a guess: a File with no type is inert, where one
 * labelled `image/jpeg` that is really something else invites whatever
 * opens it to act on the label.
 */
export function saveTypeOf(blobType: string | null | undefined): string | null {
  const type = (blobType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return SAVE_TYPES[type] ? type : null
}

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

/**
 * Only letters, digits, dash and underscore survive in a stem.
 *
 * Dots go too, inside a stem: the one dot in the name should be the one
 * before the extension this code chose, so `a.html.png` cannot keep a
 * second extension in the middle of itself and `x.` cannot produce
 * `x..jpg`.
 */
function cleanStem(text: string): string {
  return text
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[-_]+/, '')
    .replace(/-+/g, '-')
    .replace(/-+$/, '')
}

export function saveNameOf(
  url: string,
  photo: { id?: string | null; type?: string | null } = {},
): string {
  const raw = lastSegment(url)
  const dot = raw.lastIndexOf('.')
  // The type we are actually going to label the file with wins, so the
  // name and the type cannot disagree. Otherwise the url's extension,
  // if it is one we would keep.
  const fromType = saveTypeOf(photo.type)
  const fromUrl = dot > 0 ? cleanStem(raw.slice(dot + 1)).toLowerCase() : ''
  const ext = fromType ? SAVE_TYPES[fromType]! : (KEEP.has(fromUrl) ? fromUrl : 'jpg')

  let stem = cleanStem(dot > 0 ? raw.slice(0, dot) : raw).slice(0, MAX_STEM)
  if (RESERVED.has(stem.toLowerCase())) stem = `${stem}-photo`
  if (stem) return `${stem}.${ext}`

  const id = cleanStem(String(photo.id ?? '')).slice(0, MAX_STEM)
  return `photo${id ? `-${id}` : ''}.${ext}`
}
