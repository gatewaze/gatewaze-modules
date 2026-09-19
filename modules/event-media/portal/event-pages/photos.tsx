'use client'

// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * Guest photos tab — upload + live gallery for an event.
 *
 * Reached via the /u/<code> QR redirect (?u=<code> lands here) or
 * directly from the event sidebar. Upload controls render only with a
 * valid upload-link code (query param or localStorage); the gallery
 * half renders for anyone once a code is known and the link has
 * show_gallery enabled.
 *
 * localStorage (event-scoped keys, invites lesson — never a bare
 * global):
 *   event_media_upload_code:<eventIdentifier>  → short code
 *   event_media_guest:<eventIdentifier>        → { name, client_id }
 *
 * Per spec-event-media-guest-uploads §6.2.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''
const MINT_BATCH = 20
const CONCURRENCY = 3
const GALLERY_PAGE = 50
const GALLERY_REFRESH_MS = 30_000

interface Props {
  eventIdentifier: string
  primaryColor: string
  brandName: string
  darkMode?: boolean
}

interface LinkInfo {
  event: { identifier: string | null; slug: string | null; name: string | null }
  settings: {
    require_name: boolean
    allow_video: boolean
    show_gallery: boolean
    max_photo_bytes: number
    max_video_bytes: number
  }
  logo_url: string | null
}

interface GalleryItem {
  id: string
  kind: 'photo' | 'video'
  url: string
  mime_type: string
  width: number | null
  height: number | null
  variants: Record<string, string>
  guest_name: string | null
  created_at: string
}

type QueueStatus = 'waiting' | 'uploading' | 'processing' | 'done' | 'failed'

interface QueueItem {
  key: string
  file: File
  status: QueueStatus
  progress: number
  error?: string
}

/** iOS sometimes reports an empty MIME for camera files — recover the
 *  common ones from the extension so the mint allowlist can judge them. */
function effectiveMime(file: File): string {
  if (file.type) return file.type
  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  }
  return map[ext] ?? ''
}

function putWithProgress(url: string, file: File, mime: string, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    if (mime) xhr.setRequestHeader('Content-Type', mime)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('network error'))
    xhr.send(file)
  })
}

export default function GuestPhotosPage({ eventIdentifier, primaryColor, darkMode }: Props) {
  const searchParams = useSearchParams()

  const codeKey = `event_media_upload_code:${eventIdentifier}`
  const guestKey = `event_media_guest:${eventIdentifier}`

  const [code, setCode] = useState<string | null>(null)
  const [link, setLink] = useState<LinkInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [guest, setGuest] = useState<{ name: string; client_id: string } | null>(null)
  const [nameInput, setNameInput] = useState('')

  const [queue, setQueue] = useState<QueueItem[]>([])
  const queueRef = useRef<QueueItem[]>([])
  const pumpingRef = useRef(false)
  const pendingTicketsRef = useRef<string[]>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [items, setItems] = useState<GalleryItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [galleryLoading, setGalleryLoading] = useState(false)
  const [lightbox, setLightbox] = useState<GalleryItem | null>(null)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)

  // ── Code + guest bootstrap ────────────────────────────────────────

  useEffect(() => {
    const fromUrl = searchParams.get('u')
    let candidate: string | null = null
    try {
      if (fromUrl && /^[a-z0-9]{6,16}$/.test(fromUrl)) {
        localStorage.setItem(codeKey, fromUrl)
        candidate = fromUrl
      } else {
        candidate = localStorage.getItem(codeKey)
      }
      const storedGuest = localStorage.getItem(guestKey)
      if (storedGuest) {
        const parsed = JSON.parse(storedGuest)
        if (parsed && typeof parsed.name === 'string' && typeof parsed.client_id === 'string') {
          setGuest(parsed)
        }
      }
    } catch {
      // localStorage unavailable (private mode) — query param still works
      candidate = fromUrl
    }
    setCode(candidate)
    if (!candidate) setLoading(false)
  }, [searchParams, codeKey, guestKey])

  useEffect(() => {
    if (!code) return
    let cancelled = false
    fetch(`${API_BASE}/api/public/event-media/links/${code}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: LinkInfo | null) => {
        if (cancelled) return
        // Cross-event guard: a stale stored code for another event must
        // not light this page up (invites rsvp.tsx:200-207 lesson).
        if (data && data.event) {
          const ids = [data.event.identifier, data.event.slug].filter(Boolean)
          if (ids.length > 0 && !ids.includes(eventIdentifier)) {
            try { localStorage.removeItem(codeKey) } catch { /* ignore */ }
            setCode(null)
            setLink(null)
            return
          }
        }
        setLink(data)
      })
      .catch(() => { if (!cancelled) setLink(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [code, eventIdentifier, codeKey])

  // ── Gallery ───────────────────────────────────────────────────────

  const loadGallery = useCallback(async (cursor?: string | null) => {
    if (!code) return
    setGalleryLoading(true)
    try {
      const qs = new URLSearchParams({ limit: String(GALLERY_PAGE) })
      if (cursor) qs.set('cursor', cursor)
      const res = await fetch(`${API_BASE}/api/public/event-media/links/${code}/media?${qs}`)
      if (!res.ok) return
      const data = await res.json()
      setItems((prev) => {
        const merged = cursor ? [...prev, ...data.items] : [...data.items]
        const seen = new Set<string>()
        return merged.filter((i: GalleryItem) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
      })
      setNextCursor(data.next_cursor ?? null)
    } catch {
      // network hiccup — the refresh interval will retry
    } finally {
      setGalleryLoading(false)
    }
  }, [code])

  useEffect(() => {
    if (!link?.settings.show_gallery) return
    loadGallery()
    const interval = setInterval(() => loadGallery(), GALLERY_REFRESH_MS)
    return () => clearInterval(interval)
  }, [link, loadGallery])

  // ── Upload queue ──────────────────────────────────────────────────

  const setQueueSafe = useCallback((updater: (prev: QueueItem[]) => QueueItem[]) => {
    setQueue((prev) => {
      const next = updater(prev)
      queueRef.current = next
      return next
    })
  }, [])

  const patchItem = useCallback((key: string, patch: Partial<QueueItem>) => {
    setQueueSafe((prev) => prev.map((q) => (q.key === key ? { ...q, ...patch } : q)))
  }, [setQueueSafe])

  const flushCompletes = useCallback(async (force = false) => {
    if (!code) return
    // force drains everything (in ≤20-ticket batches); otherwise only a
    // full batch is worth a call — the 3 s timer mops up the tail.
    for (;;) {
      const pending = pendingTicketsRef.current
      if (pending.length === 0) return
      if (!force && pending.length < MINT_BATCH) return
      const batch = pending.splice(0, MINT_BATCH)
      try {
        const res = await fetch(`${API_BASE}/api/public/event-media/links/${code}/uploads/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tickets: batch }),
        })
        if (res.ok || res.status === 207) {
          loadGallery() // fresh uploads appear immediately
        } else {
          // put them back; the timer retries (complete is idempotent)
          pendingTicketsRef.current = [...batch, ...pendingTicketsRef.current]
          return
        }
      } catch {
        pendingTicketsRef.current = [...batch, ...pendingTicketsRef.current]
        return
      }
    }
  }, [code, loadGallery])

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null
      void flushCompletes(true)
    }, 3000)
    void flushCompletes(false)
  }, [flushCompletes])

  // One mint call covers up to MINT_BATCH files (the per-client mint
  // rate limit is 20/min — minting per-file would lock a 100-photo
  // batch out). PUTs then run with bounded concurrency.
  const putMinted = useCallback(async (item: QueueItem, minted: { upload_url: string; ticket: string }) => {
    const mime = effectiveMime(item.file)
    try {
      await putWithProgress(minted.upload_url, item.file, mime, (pct) => patchItem(item.key, { progress: pct }))
      patchItem(item.key, { status: 'processing', progress: 100 })
      pendingTicketsRef.current.push(minted.ticket)
      scheduleFlush()
      patchItem(item.key, { status: 'done' })
    } catch (err) {
      patchItem(item.key, { status: 'failed', error: err instanceof Error ? err.message : 'upload failed' })
    }
  }, [patchItem, scheduleFlush])

  const pumpQueue = useCallback(async () => {
    if (pumpingRef.current) return
    pumpingRef.current = true
    try {
      for (;;) {
        const batch = queueRef.current.filter((q) => q.status === 'waiting').slice(0, MINT_BATCH)
        if (batch.length === 0) break
        if (!code || !guest) break

        batch.forEach((q) => patchItem(q.key, { status: 'uploading', progress: 0 }))
        let mintData: { items?: Array<Record<string, unknown>> } | null = null
        try {
          const mintRes = await fetch(`${API_BASE}/api/public/event-media/links/${code}/uploads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              guest_name: guest.name,
              client_id: guest.client_id,
              files: batch.map((q) => ({
                filename: q.file.name || 'photo.jpg',
                mime_type: effectiveMime(q.file),
                bytes: q.file.size,
                captured: q.key.startsWith('cam-'),
              })),
            }),
          })
          mintData = await mintRes.json().catch(() => null)
        } catch {
          mintData = null
        }
        if (!mintData?.items) {
          batch.forEach((q) => patchItem(q.key, { status: 'failed', error: 'could not start upload' }))
          continue
        }

        // Mint results come back in request order.
        const jobs: Array<() => Promise<void>> = []
        batch.forEach((q, i) => {
          const minted = mintData!.items![i] as { status?: string; message?: string; upload_url?: string; ticket?: string } | undefined
          if (!minted || minted.status !== 'ready' || !minted.upload_url || !minted.ticket) {
            patchItem(q.key, { status: 'failed', error: minted?.message ?? 'could not start upload' })
            return
          }
          jobs.push(() => putMinted(q, { upload_url: minted.upload_url!, ticket: minted.ticket! }))
        })

        // Bounded-concurrency pool over this batch's PUTs.
        let cursor = 0
        const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
          while (cursor < jobs.length) {
            const job = jobs[cursor]
            cursor += 1
            await job()
          }
        })
        await Promise.all(workers)
      }
      await flushCompletes(true)
    } finally {
      pumpingRef.current = false
    }
  }, [code, guest, patchItem, putMinted, flushCompletes])

  const enqueueFiles = useCallback((files: FileList | null, camera: boolean) => {
    if (!files || files.length === 0) return
    const stamp = Date.now()
    const fresh: QueueItem[] = Array.from(files).map((file, i) => ({
      key: `${camera ? 'cam' : 'pick'}-${stamp}-${i}-${file.name}`,
      file,
      status: 'waiting',
      progress: 0,
    }))
    setQueueSafe((prev) => [...prev, ...fresh])
    void pumpQueue()
  }, [setQueueSafe, pumpQueue])

  const retryItem = useCallback((key: string) => {
    patchItem(key, { status: 'waiting', progress: 0, error: undefined })
    void pumpQueue()
  }, [patchItem, pumpQueue])

  // Safety net: retry stranded completion tickets (a failed flush keeps
  // them pending; complete is idempotent so re-sending is safe).
  useEffect(() => {
    const iv = setInterval(() => {
      if (pendingTicketsRef.current.length > 0) void flushCompletes(true)
    }, 10_000)
    return () => clearInterval(iv)
  }, [flushCompletes])

  // Warn before leaving mid-upload.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const busy = queueRef.current.some((q) => q.status === 'waiting' || q.status === 'uploading' || q.status === 'processing')
      if (busy || pendingTicketsRef.current.length > 0) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // ── Name gate ─────────────────────────────────────────────────────

  const saveName = useCallback(() => {
    const name = nameInput.trim().slice(0, 80)
    if (!name) return
    // The server requires a UUID client_id — keep the fallback (old
    // WebViews without crypto.randomUUID) UUID-shaped.
    const fallbackUuid = () =>
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        const v = c === 'x' ? r : (r & 0x3) | 0x8
        return v.toString(16)
      })
    const next = {
      name,
      client_id: guest?.client_id ?? (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : fallbackUuid()),
    }
    setGuest(next)
    try { localStorage.setItem(guestKey, JSON.stringify(next)) } catch { /* private mode */ }
  }, [nameInput, guest, guestKey])

  // ── Render ────────────────────────────────────────────────────────

  const text = darkMode ? 'text-white' : 'text-gray-900'
  const subText = darkMode ? 'text-gray-300' : 'text-gray-600'
  const cardBg = darkMode ? 'bg-white/10' : 'bg-white'

  if (loading) {
    return <div className={`p-8 text-center ${subText}`}>Loading…</div>
  }

  const canUpload = Boolean(code && link)
  const needsName = canUpload && link!.settings.require_name && !guest
  const activeCount = queue.filter((q) => q.status === 'waiting' || q.status === 'uploading' || q.status === 'processing').length
  const failedItems = queue.filter((q) => q.status === 'failed')

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      {/* Upload bar */}
      {canUpload && (
        <div className={`${cardBg} rounded-2xl shadow p-5 mb-6`}>
          {needsName ? (
            <div>
              <h2 className={`text-lg font-semibold mb-1 ${text}`}>Add your photos</h2>
              <p className={`text-sm mb-3 ${subText}`}>Tell us your name once — it&apos;s remembered on this device.</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveName() }}
                  placeholder="Your name"
                  maxLength={80}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-gray-900"
                />
                <button
                  onClick={saveName}
                  disabled={!nameInput.trim()}
                  className="rounded-lg px-4 py-2 font-medium text-white disabled:opacity-50"
                  style={{ backgroundColor: primaryColor }}
                >
                  That&apos;s me
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className={`text-lg font-semibold ${text}`}>Add your photos</h2>
                  {guest && (
                    <p className={`text-xs ${subText}`}>
                      Uploading as <span className="font-medium">{guest.name}</span>{' '}
                      <button
                        className="underline"
                        onClick={() => { setGuest(null); setNameInput(''); try { localStorage.removeItem(guestKey) } catch { /* ignore */ } }}
                      >
                        not you?
                      </button>
                    </p>
                  )}
                </div>
                {activeCount > 0 && (
                  <span className={`text-sm ${subText}`}>{activeCount} uploading…</span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => cameraInputRef.current?.click()}
                  className="rounded-lg px-4 py-2 font-medium text-white"
                  style={{ backgroundColor: primaryColor }}
                >
                  📷 Take a photo
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className={`rounded-lg px-4 py-2 font-medium border ${darkMode ? 'border-white/40 text-white' : 'border-gray-300 text-gray-800'}`}
                >
                  {link!.settings.allow_video ? 'Add photos & videos' : 'Add photos'}
                </button>
              </div>
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => { enqueueFiles(e.target.files, true); e.target.value = '' }}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={link!.settings.allow_video ? 'image/*,video/mp4,video/quicktime,video/webm' : 'image/*'}
                className="hidden"
                onChange={(e) => { enqueueFiles(e.target.files, false); e.target.value = '' }}
              />

              {/* Queue */}
              {queue.length > 0 && (
                <div className="mt-4 space-y-1 max-h-48 overflow-y-auto">
                  {queue.slice(-30).map((q) => (
                    <div key={q.key} className={`flex items-center gap-2 text-xs ${subText}`}>
                      <span className="truncate flex-1">{q.file.name}</span>
                      {q.status === 'uploading' && (
                        <span className="w-24 h-1.5 bg-gray-300 rounded overflow-hidden">
                          <span className="block h-full" style={{ width: `${q.progress}%`, backgroundColor: primaryColor }} />
                        </span>
                      )}
                      {q.status === 'waiting' && <span>queued</span>}
                      {q.status === 'processing' && <span>finishing…</span>}
                      {q.status === 'done' && <span className="text-green-600">✓</span>}
                      {q.status === 'failed' && (
                        <button className="text-red-500 underline" onClick={() => retryItem(q.key)}>
                          retry
                        </button>
                      )}
                    </div>
                  ))}
                  {failedItems.length > 0 && (
                    <button
                      className="text-xs underline text-red-500"
                      onClick={() => failedItems.forEach((q) => retryItem(q.key))}
                    >
                      Retry all failed ({failedItems.length})
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {!canUpload && (
        <div className={`${cardBg} rounded-2xl shadow p-5 mb-6`}>
          <p className={`text-sm ${subText}`}>
            Scan the event&apos;s photo QR code to add your own photos here.
          </p>
        </div>
      )}

      {/* Gallery */}
      {link?.settings.show_gallery && (
        <div>
          <h2 className={`text-lg font-semibold mb-3 ${text}`}>Photos so far</h2>
          {items.length === 0 && !galleryLoading && (
            <p className={`text-sm ${subText}`}>No photos yet — be the first!</p>
          )}
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-1.5">
            {items.map((item) => (
              <button
                key={item.id}
                className="relative aspect-square overflow-hidden rounded-lg bg-gray-200 group"
                onClick={() => setLightbox(item)}
              >
                {item.kind === 'video' ? (
                  <>
                    <video src={item.url} muted playsInline preload="metadata" className="w-full h-full object-cover" />
                    <span className="absolute inset-0 flex items-center justify-center text-white text-2xl drop-shadow">▶</span>
                  </>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- module gallery grid; thumbs come pre-sized from the variants pipeline
                  <img
                    src={item.variants?.thumb || item.url}
                    alt={item.guest_name ? `Photo by ${item.guest_name}` : 'Event photo'}
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                )}
                {item.guest_name && (
                  <span className="absolute bottom-0 inset-x-0 bg-black/50 text-white text-[10px] px-1 py-0.5 truncate opacity-0 group-hover:opacity-100">
                    {item.guest_name}
                  </span>
                )}
              </button>
            ))}
          </div>
          {nextCursor && (
            <div className="mt-4 text-center">
              <button
                onClick={() => loadGallery(nextCursor)}
                disabled={galleryLoading}
                className={`rounded-lg px-4 py-2 text-sm border ${darkMode ? 'border-white/40 text-white' : 'border-gray-300 text-gray-800'}`}
              >
                {galleryLoading ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setLightbox(null)}
        >
          <div className="max-w-4xl max-h-full" onClick={(e) => e.stopPropagation()}>
            {lightbox.kind === 'video' ? (
              <video src={lightbox.url} controls autoPlay playsInline className="max-w-full max-h-[85vh]" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- lightbox shows the stored medium/original directly
              <img
                src={lightbox.variants?.medium || lightbox.url}
                alt={lightbox.guest_name ? `Photo by ${lightbox.guest_name}` : 'Event photo'}
                className="max-w-full max-h-[85vh] object-contain"
              />
            )}
            {lightbox.guest_name && (
              <p className="text-center text-white/80 text-sm mt-2">by {lightbox.guest_name}</p>
            )}
          </div>
          <button className="absolute top-4 right-4 text-white text-3xl" onClick={() => setLightbox(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  )
}
