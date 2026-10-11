/**
 * The guest's own booth pictures, kept on their phone.
 *
 * Every picture the booth makes goes on a Polaroid in a carousel the
 * guest can scroll back through, post to the big screen, or save -- all
 * of them, whether or not they were ever posted or saved. The
 * list lives in IndexedDB, keyed per event, so a phone that reloads the
 * tab (which phones do, constantly) does not lose the evening's pictures.
 * Nothing here leaves the device; posting is the page's normal upload.
 *
 * The list logic is pure and tested; the storage is best-effort and
 * falls back to memory if the browser refuses it.
 */

export interface BoothPicture {
  id: string
  /** data: URL of the picture. */
  image: string
  /** The look it was made in, e.g. "1970s"; null for an untouched photo. */
  label: string | null
  /** A made picture rather than the guest's original. */
  styled: boolean
  /** Shown under the picture, e.g. why the look did not apply. */
  note: string | null
  createdAt: number
  /** Already sent to the big screen from this phone. */
  posted: boolean
  /** The upload it became, so deleting it can remove it from the site. */
  mediaId: string | null
}

/** Every picture of a long evening; beyond it the oldest go. */
export const HISTORY_CAP = 40

/** Newest first, no duplicates, capped. */
export function addPicture(list: BoothPicture[], pic: BoothPicture, cap: number = HISTORY_CAP): BoothPicture[] {
  return [pic, ...list.filter((p) => p.id !== pic.id && p.image !== pic.image)].slice(0, Math.max(1, cap))
}

export function markPosted(list: BoothPicture[], id: string, mediaId: string | null = null): BoothPicture[] {
  return list.map((p) => (p.id === id ? { ...p, posted: true, mediaId: mediaId ?? p.mediaId } : p))
}

export function markUnposted(list: BoothPicture[], id: string): BoothPicture[] {
  return list.map((p) => (p.id === id ? { ...p, posted: false } : p))
}

export function removePicture(list: BoothPicture[], id: string): BoothPicture[] {
  return list.filter((p) => p.id !== id)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Only well-formed pictures survive a load: storage is not trusted. */
export function sanitiseHistory(raw: unknown): BoothPicture[] {
  if (!Array.isArray(raw)) return []
  const out: BoothPicture[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const p = r as Record<string, unknown>
    if (typeof p['id'] !== 'string' || typeof p['image'] !== 'string') continue
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(p['image'] as string)) continue
    out.push({
      id: p['id'] as string,
      image: p['image'] as string,
      label: typeof p['label'] === 'string' ? (p['label'] as string) : null,
      styled: p['styled'] === true,
      note: typeof p['note'] === 'string' ? (p['note'] as string) : null,
      createdAt: typeof p['createdAt'] === 'number' ? (p['createdAt'] as number) : 0,
      posted: p['posted'] === true,
      mediaId: typeof p['mediaId'] === 'string' && UUID_RE.test(p['mediaId'] as string) ? (p['mediaId'] as string) : null,
    })
  }
  return out.slice(0, HISTORY_CAP)
}

const DB = 'event-media-booth'
const STORE = 'history'

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return }
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function loadHistory(key: string): Promise<BoothPicture[]> {
  const db = await open()
  if (!db) return []
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      req.onsuccess = () => resolve(sanitiseHistory(req.result))
      req.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

export async function saveHistory(key: string, list: BoothPicture[]): Promise<void> {
  const db = await open()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(list, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}
