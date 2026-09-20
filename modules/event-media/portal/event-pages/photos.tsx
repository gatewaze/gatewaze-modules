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
import { createPortal } from 'react-dom'
import { useSearchParams } from 'next/navigation'
import DisplayView from './_components/DisplayView'

// Same-origin ALWAYS: the portal proxies /api/public/* to the api
// service (next.config rewrites). NEXT_PUBLIC_API_URL is unreliable in
// the browser — on k8s portals it's the in-cluster service DNS, which
// a phone can't resolve (found live on autodb 2026-09-19).
const API_BASE = ''
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
  event: { identifier: string | null; slug: string | null; event_id?: string | null; name: string | null }
  settings: {
    require_name: boolean
    allow_video: boolean
    show_gallery: boolean
    max_photo_bytes: number
    max_video_bytes: number
  }
  logo_url: string | null
  face_filters?: Array<{ id: string; label: string; preview: string }>
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
  /** Only present in the "yours" listing: awaiting admin approval. */
  pending?: boolean
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
  // Tickets awaiting the complete call, paired with their queue key so
  // ✓ is only shown once the row actually exists server-side.
  const pendingTicketsRef = useRef<Array<{ ticket: string; key: string }>>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [items, setItems] = useState<GalleryItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [galleryLoading, setGalleryLoading] = useState(false)
  const [lightbox, setLightbox] = useState<GalleryItem | null>(null)

  // "Yours" view: a guest's own uploads, so a wrong photo can be
  // removed. Ownership is the device's client_id.
  const [tab, setTab] = useState<'all' | 'mine'>('all')
  // Mirrored in a ref so the upload-completion callback can check the
  // active tab without being re-created on every tab change.
  const tabRef = useRef<'all' | 'mine'>('all')
  useEffect(() => { tabRef.current = tab }, [tab])
  const [mine, setMine] = useState<GalleryItem[]>([])
  const [mineLoading, setMineLoading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  // A camera shot held back for the filter step: nothing is uploaded
  // until the guest picks a version.
  const [shot, setShot] = useState<{
    original: string
    preview: string | null
    filterLabel: string | null
    busy: boolean
    error: string | null
  } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)

  // Mobile detection for the upload takeover. Tracked via matchMedia so
  // the takeover can render through a PORTAL to document.body —
  // position:fixed inside the event shell gets re-anchored (and dimmed)
  // by an ancestor with transform/opacity, which is exactly what the
  // 2026-09-19 phone test showed (grey wash on white).
  const [mounted, setMounted] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const takeoverRef = useRef<HTMLDivElement | null>(null)
  // Mirrors the render-time canUpload so the backdrop effect can read
  // it without depending on render order.
  const canUploadRef = useRef(false)
  useEffect(() => {
    setMounted(true)
    const mq = window.matchMedia('(max-width: 767px)')
    const apply = () => setIsMobile(mq.matches)
    apply()
    mq.addEventListener?.('change', apply)
    return () => mq.removeEventListener?.('change', apply)
  }, [])

  // While the mobile takeover is up, hide the event page itself but
  // keep the brand's animated gradient. That gradient is a decorative
  // fixed body-child (pointer-events:none, z-0), so everything EXCEPT
  // those layers and our own portal gets visibility:hidden — which
  // leaves the backdrop intact without us having to know anything
  // about the brand's markup. visibility, not display, so the page
  // does not reflow or lose its scroll position underneath.
  useEffect(() => {
    if (!(canUploadRef.current && mounted && isMobile)) return
    const node = takeoverRef.current
    if (!node) return
    const touched: Array<[HTMLElement, string]> = []
    for (const el of Array.from(document.body.children)) {
      if (!(el instanceof HTMLElement)) continue
      if (el === node || el.contains(node)) continue
      const cs = getComputedStyle(el)
      const decorative = cs.position === 'fixed' && cs.pointerEvents === 'none'
      if (decorative) continue
      touched.push([el, el.style.visibility])
      el.style.visibility = 'hidden'
    }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      for (const [el, prev] of touched) el.style.visibility = prev
      document.body.style.overflow = prevOverflow
    }
  })

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
          // Accept every URL spelling the event page resolves (slug OR
          // text event_id) — rejecting one wrongly clears a valid code.
          const ids = [data.event.identifier, data.event.slug, data.event.event_id].filter(Boolean)
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

  // ── Face filters (camera shots only) ──────────────────────────────

  /** Shrink before sending: a 24 MP selfie is pointless to swap and
   *  slow to upload twice. 1600px is plenty for the result. */
  const toDataUrl = useCallback((file: File): Promise<string | null> => {
    return new Promise((resolve) => {
      const img = new window.Image()
      const url = URL.createObjectURL(file)
      img.onload = () => {
        URL.revokeObjectURL(url)
        const longEdge = Math.max(img.naturalWidth, img.naturalHeight)
        const scale = longEdge > 1600 ? 1600 / longEdge : 1
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.naturalWidth * scale)
        canvas.height = Math.round(img.naturalHeight * scale)
        const ctx = canvas.getContext('2d')
        if (!ctx) { resolve(null); return }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', 0.9))
      }
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
      img.src = url
    })
  }, [])

  const onCameraShot = useCallback(async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    const filters = link?.face_filters ?? []
    // No filters configured → behave exactly as before.
    if (filters.length === 0) { enqueueFiles(files, true); return }
    const dataUrl = await toDataUrl(file)
    if (!dataUrl) { enqueueFiles(files, true); return }
    setShot({ original: dataUrl, preview: null, filterLabel: null, busy: false, error: null })
  }, [link, enqueueFiles, toDataUrl])

  const applyFilter = useCallback(async (filterId: string) => {
    if (!code || !guest || !shot) return
    setShot((s) => (s ? { ...s, busy: true, error: null } : s))
    try {
      const res = await fetch(`${API_BASE}/api/public/event-media/links/${code}/face-filter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: guest.client_id, filter_id: filterId, image: shot.original }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.image) {
        setShot((s) => (s ? {
          ...s,
          busy: false,
          error: data?.message ?? 'that filter did not work — you can still upload your photo',
        } : s))
        return
      }
      setShot((s) => (s ? { ...s, busy: false, preview: data.image, filterLabel: data.filter?.label ?? null } : s))
    } catch {
      setShot((s) => (s ? { ...s, busy: false, error: 'could not reach the filter' } : s))
    }
  }, [code, guest, shot])

  /** Upload whichever version the guest settled on. */
  const acceptShot = useCallback(async () => {
    if (!shot) return
    const chosen = shot.preview ?? shot.original
    const blob = await (await fetch(chosen)).blob()
    const name = shot.preview ? `filtered-${Date.now()}.jpg` : `photo-${Date.now()}.jpg`
    const file = new File([blob], name, { type: 'image/jpeg' })
    const dt = new DataTransfer()
    dt.items.add(file)
    enqueueFiles(dt.files, true)
    setShot(null)
  }, [shot, enqueueFiles])

  // ── "Yours": the guest's own uploads ──────────────────────────────

  const loadMine = useCallback(async () => {
    if (!code || !guest) return
    setMineLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/public/event-media/links/${code}/mine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: guest.client_id }),
      })
      if (!res.ok) return
      const data = await res.json()
      setMine(data.items ?? [])
    } catch {
      // transient — the tab can be reopened
    } finally {
      setMineLoading(false)
    }
  }, [code, guest])

  useEffect(() => {
    if (tab === 'mine') void loadMine()
  }, [tab, loadMine])

  const deleteMine = useCallback(async (id: string) => {
    if (!code || !guest) return
    setDeleting(id)
    try {
      const res = await fetch(`${API_BASE}/api/public/event-media/links/${code}/mine/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: guest.client_id, media_id: id }),
      })
      if (res.ok) {
        // Drop it from both lists straight away rather than waiting
        // for the next poll.
        setMine((prev) => prev.filter((i) => i.id !== id))
        setItems((prev) => prev.filter((i) => i.id !== id))
        setLightbox((l) => (l && l.id === id ? null : l))
      }
    } catch {
      // leave the item in place; the guest can try again
    } finally {
      setDeleting(null)
      setConfirmDelete(null)
    }
  }, [code, guest])

  // ── Upload queue ──────────────────────────────────────────────────

  // queueRef is the SYNCHRONOUS source of truth; React state mirrors it
  // for rendering. Updating the ref inside setQueue's updater is too
  // late — React defers updaters, so pumpQueue read an empty ref right
  // after enqueue and exited, leaving items stuck "queued" (found live
  // on mobile 2026-09-19).
  const setQueueSafe = useCallback((updater: (prev: QueueItem[]) => QueueItem[]) => {
    queueRef.current = updater(queueRef.current)
    setQueue(queueRef.current)
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
          body: JSON.stringify({ tickets: batch.map((b) => b.ticket) }),
        })
        if (res.ok || res.status === 207) {
          // Per-item results come back in ticket order — only now does
          // an item earn its ✓ (or surface a completion failure).
          const data = await res.json().catch(() => null)
          batch.forEach((b, i) => {
            const item = data?.items?.[i]
            if (item && (item.status === 'created' || item.status === 'already_created')) {
              patchItem(b.key, { status: 'done' })
            } else {
              patchItem(b.key, { status: 'failed', error: item?.error ?? 'completion failed' })
            }
          })
          loadGallery() // fresh uploads appear immediately
          if (tabRef.current === 'mine') void loadMine()
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
      // "finishing…" until the complete call confirms the row exists —
      // flushCompletes flips it to done/failed per the server's answer.
      patchItem(item.key, { status: 'processing', progress: 100 })
      pendingTicketsRef.current.push({ ticket: minted.ticket, key: item.key })
      scheduleFlush()
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
  // them pending; complete is idempotent so re-sending is safe), and
  // re-kick the pump if waiting items ever exist without one running.
  useEffect(() => {
    const iv = setInterval(() => {
      if (pendingTicketsRef.current.length > 0) void flushCompletes(true)
      if (!pumpingRef.current && queueRef.current.some((q) => q.status === 'waiting')) void pumpQueue()
    }, 10_000)
    return () => clearInterval(iv)
  }, [flushCompletes, pumpQueue])

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

  // Projector mode: ?display=1 swaps the whole tab for the full-bleed
  // display view (renders position:fixed above the event chrome). This
  // is the reachable home for the projector — module portal pages are
  // nav-visibility-gated and event-media has no nav entry.
  if (searchParams.get('display') === '1' && code) {
    return <DisplayView code={code} />
  }

  if (loading) {
    return <div className={`p-8 text-center ${subText}`}>Loading…</div>
  }

  const canUpload = Boolean(code && link)
  canUploadRef.current = canUpload
  const needsName = canUpload && link!.settings.require_name && !guest
  const activeCount = queue.filter((q) => q.status === 'waiting' || q.status === 'uploading' || q.status === 'processing').length
  const failedItems = queue.filter((q) => q.status === 'failed')

  // On phones, a guest with an upload code gets a full-viewport
  // takeover — the event hero eats half the screen otherwise and this
  // page is about uploading, not browsing the event. Rendered through a
  // PORTAL to document.body so no event-shell ancestor (transform/
  // opacity) can re-anchor the fixed positioning or dim the content.
  // Desktop keeps the normal in-page layout.
  const mobileTakeover = canUpload && mounted && isMobile

  const pageContent = (
    <div className="max-w-5xl mx-auto px-4 py-6">
      {mobileTakeover && (
        <div className="mb-3 pt-2">
          <p className={`text-base font-semibold ${text}`}>{link!.event.name ?? 'Event photos'}</p>
          <p className={`text-xs ${subText}`}>Share your photos from the day</p>
        </div>
      )}
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
                  className="rounded-lg px-4 py-2 font-medium text-white inline-flex items-center gap-2"
                  style={{ backgroundColor: primaryColor }}
                >
                  {/* house line-style (outline) camera icon — no emoji */}
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM18.75 10.5h.008v.008h-.008V10.5z" />
                  </svg>
                  Take a photo
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
                onChange={(e) => { onCameraShot(e.target.files); e.target.value = '' }}
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
          <div className="flex items-center gap-2 mb-3">
            <h2 className={`text-lg font-semibold ${text}`}>
              {tab === 'all' ? 'Photos so far' : 'Your uploads'}
            </h2>
            <span className="flex-1" />
            {guest && (
              <div className="flex gap-1">
                {([
                  ['all', 'Everyone'],
                  ['mine', 'Yours'],
                ] as const).map(([val, label]) => (
                  <button
                    key={val}
                    onClick={() => setTab(val)}
                    className={`rounded-lg px-3 py-1 text-sm ${
                      tab === val
                        ? 'bg-white text-gray-900 font-medium'
                        : darkMode ? 'bg-white/10 text-white/80' : 'bg-black/5 text-gray-700'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {tab === 'mine' && (
            <>
              {mineLoading && mine.length === 0 && (
                <p className={`text-sm ${subText}`}>Loading your uploads…</p>
              )}
              {!mineLoading && mine.length === 0 && (
                <p className={`text-sm ${subText}`}>
                  You haven&apos;t added anything yet. Anything you upload from this device shows here,
                  and you can remove it if it was the wrong one.
                </p>
              )}
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-1.5">
                {mine.map((item) => (
                  <div key={item.id} className="relative aspect-square overflow-hidden rounded-lg bg-gray-200">
                    <button className="absolute inset-0" onClick={() => setLightbox(item)}>
                      {item.kind === 'video' ? (
                        <>
                          <video src={item.url} muted playsInline preload="metadata" className="w-full h-full object-cover" />
                          <span className="absolute inset-0 flex items-center justify-center text-white text-2xl drop-shadow">▶</span>
                        </>
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element -- module gallery grid
                        <img
                          src={item.variants?.thumb || item.url}
                          alt=""
                          loading="lazy"
                          className="w-full h-full object-cover"
                        />
                      )}
                    </button>
                    {item.pending && (
                      <span className="absolute top-1 left-1 rounded bg-amber-500/90 text-white text-[10px] px-1.5 py-0.5">
                        awaiting approval
                      </span>
                    )}
                    {confirmDelete === item.id ? (
                      <div className="absolute inset-0 bg-black/75 flex flex-col items-center justify-center gap-1.5 p-2">
                        <span className="text-white text-xs text-center">Remove this?</span>
                        <div className="flex gap-1.5">
                          <button
                            className="rounded bg-red-600 text-white text-xs px-2.5 py-1 disabled:opacity-60"
                            disabled={deleting === item.id}
                            onClick={() => deleteMine(item.id)}
                          >
                            {deleting === item.id ? 'Removing…' : 'Remove'}
                          </button>
                          <button
                            className="rounded bg-white/20 text-white text-xs px-2.5 py-1"
                            onClick={() => setConfirmDelete(null)}
                          >
                            Keep
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        aria-label="Remove this upload"
                        onClick={() => setConfirmDelete(item.id)}
                        className="absolute top-1 right-1 w-7 h-7 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80"
                      >
                        {/* line-style trash icon */}
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'all' && items.length === 0 && !galleryLoading && (
            <p className={`text-sm ${subText}`}>No photos yet — be the first!</p>
          )}
          <div className={`grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-1.5 ${tab === 'all' ? '' : 'hidden'}`}>
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
          {tab === 'all' && nextCursor && (
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

      {/* Camera shot + filter step. Nothing here has been uploaded:
          the guest chooses the original or a filtered version, and
          can always back out entirely. */}
      {shot && (
        <div className="fixed inset-0 z-[60] bg-black/95 flex flex-col">
          <div className="flex-1 min-h-0 flex items-center justify-center p-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- local data URL preview */}
            <img
              src={shot.preview ?? shot.original}
              alt=""
              className="max-w-full max-h-full object-contain rounded-xl"
            />
          </div>

          <div className="p-4 pb-6 space-y-3 bg-black/80">
            {shot.error && <p className="text-amber-300 text-sm">{shot.error}</p>}
            {shot.preview && (
              <p className="text-white/70 text-sm">
                Filtered{shot.filterLabel ? ` — ${shot.filterLabel}` : ''}. Happy with it?
              </p>
            )}

            <div className="flex gap-2 overflow-x-auto pb-1">
              {(link?.face_filters ?? []).map((f) => (
                <button
                  key={f.id}
                  onClick={() => applyFilter(f.id)}
                  disabled={shot.busy}
                  className="flex-shrink-0 flex flex-col items-center gap-1 disabled:opacity-50"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- reference face */}
                  <img src={f.preview} alt="" className="w-14 h-14 rounded-full object-cover ring-2 ring-white/30" />
                  <span className="text-white/80 text-xs">{f.label}</span>
                </button>
              ))}
              {shot.preview && (
                <button
                  onClick={() => setShot((s) => (s ? { ...s, preview: null, filterLabel: null } : s))}
                  disabled={shot.busy}
                  className="flex-shrink-0 flex flex-col items-center gap-1 disabled:opacity-50"
                >
                  <span className="w-14 h-14 rounded-full bg-white/10 ring-2 ring-white/30 flex items-center justify-center text-white text-xs">
                    Original
                  </span>
                  <span className="text-white/80 text-xs">No filter</span>
                </button>
              )}
            </div>

            {shot.busy && <p className="text-white/60 text-sm">Applying the filter…</p>}

            <div className="flex gap-2">
              <button
                onClick={acceptShot}
                disabled={shot.busy}
                className="flex-1 rounded-lg px-4 py-2.5 font-medium text-white disabled:opacity-50"
                style={{ backgroundColor: primaryColor }}
              >
                {shot.preview ? 'Upload this one' : 'Upload photo'}
              </button>
              <button
                onClick={() => setShot(null)}
                disabled={shot.busy}
                className="rounded-lg px-4 py-2.5 text-white/80 bg-white/10 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
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

  if (mobileTakeover) {
    return createPortal(
      // No background of its own: the page content underneath is
      // hidden by the effect above, leaving only the brand's animated
      // gradient layer visible behind the upload UI. Painting a solid
      // colour here instead flattened it to plain navy, and leaving it
      // transparent without hiding the content showed the event hero
      // straight through (both reported by Dan, 2026-09-20).
      <div ref={takeoverRef} className="fixed inset-0 z-50 overflow-y-auto overscroll-contain">
        {pageContent}
      </div>,
      document.body,
    )
  }

  return pageContent
}
