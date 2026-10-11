/**
 * Delivering a photographer's photographs: the parts with no browser in
 * them, so they can be tested.
 *
 * A wedding photographer arrives with thousands of files weeks later. The
 * guests' own page is built for a phone and a handful of photographs at a
 * time; this is built for a laptop and eight thousand, which means three
 * things matter that do not matter there: that the same delivery can be
 * picked up again after a closed laptop, that one bad file does not stop
 * the rest, and that the page can say honestly how far through it is.
 */

/** What the page knows about one file it has been given. */
export interface DeliveryFile {
  name: string
  size: number
  type: string
}

/** Files already delivered, as this browser remembers them. */
export type Delivered = ReadonlySet<string>

/**
 * A file's identity for "have we had this one already".
 *
 * Name and size together: a photographer's files are numbered by the
 * camera, and two different photographs with the same name and the same
 * byte count does not happen. Deliberately not a hash -- reading eight
 * thousand files to hash them would take longer than uploading them.
 */
export function fileKey(file: DeliveryFile): string {
  return `${file.name}:${file.size}`
}

/** Which of these have not been delivered yet, in the order given. */
export function toDeliver(files: readonly DeliveryFile[], already: Delivered): DeliveryFile[] {
  const seen = new Set<string>()
  return files.filter((f) => {
    const key = fileKey(f)
    // A folder picked twice in one go is still one photograph.
    if (already.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Whether we will take this file at all.
 *
 * A photographer's folder has more in it than photographs: contact
 * sheets as PDFs, a Lightroom catalogue, .DS_Store. Anything that is not
 * a photograph (or a video, where the link allows them) is passed over
 * quietly rather than failed loudly.
 */
export function isDeliverable(file: DeliveryFile, opts: { allowVideo: boolean }): boolean {
  if (file.size <= 0) return false
  if (/^image\/(jpeg|png|webp|heic|heif|gif)$/i.test(file.type)) return true
  if (opts.allowVideo && /^video\/(mp4|quicktime|webm)$/i.test(file.type)) return true
  // Some browsers hand over a folder with no types at all; fall back to
  // what the name says.
  if (!file.type) return /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(file.name)
  return false
}

/** Files in batches, as the mint endpoint takes them. */
export function inBatches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)))
  return out
}

export interface DeliveryProgress {
  /** Files chosen, after the ones we will not take are dropped. */
  total: number
  done: number
  failed: number
  /** Already delivered in an earlier sitting, so passed over. */
  skipped: number
}

/** How far through, in words a photographer can read at a glance. */
export function progressLine(p: DeliveryProgress): string {
  if (p.total === 0) return p.skipped > 0 ? 'Everything here has been delivered already.' : ''
  const parts = [`${p.done.toLocaleString()} of ${p.total.toLocaleString()} sent`]
  if (p.failed > 0) parts.push(`${p.failed.toLocaleString()} could not be sent`)
  if (p.skipped > 0) parts.push(`${p.skipped.toLocaleString()} already here`)
  return parts.join(' · ')
}
