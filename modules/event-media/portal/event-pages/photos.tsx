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

import { Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'next/navigation'
import DisplayView from './_components/DisplayView'
import GuestPicker from './_components/GuestPicker'
import UploadApp, { type UploadTile } from './_components/UploadApp'
import BoothExperience, { type BoothLook, type BoothView } from './_components/BoothExperience'

// Same-origin ALWAYS: the portal proxies /api/public/* to the api
// service (next.config rewrites). NEXT_PUBLIC_API_URL is unreliable in
// the browser — on k8s portals it's the in-cluster service DNS, which
// a phone can't resolve (found live on autodb 2026-09-19).
const API_BASE = ''
const MINT_BATCH = 20
const CONCURRENCY = 3
const GALLERY_PAGE = 50
// Everyone's photos refresh while the guest is looking at them.
const GALLERY_REFRESH_MS = 8_000

// Booth generation takes 13-20 seconds and the provider reports no
// progress at all. So the bar is honest about that: it eases toward 90%
// and only finishes when the picture actually lands. A faked percentage
// parks at 99% and reads as a hang, which is worse than a bar that is
// plainly just saying "still working".
const BOOTH_TAU_MS = 6_000
const BOOTH_CEILING = 90
const BOOTH_STATUS_MS = 4_000

// What "Save to my photos" is allowed to put on a camera roll, and the
// extension each one gets. An allowlist rather than a passthrough: the
// media type comes off a data: URL and ends up on a File handed to the
// OS share sheet.
const BOOTH_SAVE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}
const BOOTH_STATUS = [
  'Setting the scene…',
  'Finding your best side…',
  'Developing…',
  'Almost there…',
]

// Plain <style>, not styled-jsx: module portal pages must not depend on
// compiler transforms beyond what every sibling page already uses. Same
// pattern as _components/DisplayView.tsx.
const BOOTH_KEYFRAMES = `
@keyframes booth-sheen {
  from { transform: translateX(-100%) }
  to   { transform: translateX(300%) }
}
@keyframes booth-say {
  from { opacity: 0; transform: translateY(4px) }
  to   { opacity: 1; transform: none }
}
@media (prefers-reduced-motion: reduce) {
  .booth-sheen { animation: none }
  .booth-say { animation: none }
}
`

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
    /** Guests choose their name from the invitation list. */
    guest_list?: boolean
    allow_video: boolean
    show_gallery: boolean
    max_photo_bytes: number
    max_video_bytes: number
  }
  logo_url: string | null
  face_filters?: Array<{ id: string; label: string; preview: string }>
  booth_effects?: Array<{ id: string; label: string; blurb: string; kind: 'swap' | 'style' }>
  /** The illustrated booth, when the event has one (lib/booth-theme.ts). */
  booth?: BoothView | null
  /** The morning before the event (lib/ready-prompts.ts). */
  ready?: {
    active: boolean
    starts_at: string | null
    prompts: Array<{ id: string; label: string; blurb: string; camera: 'user' | 'environment' }>
  } | null
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
  /** Which of the morning's asks this answers (lib/ready-prompts.ts). */
  prompt?: string | null
  /** Booth output — goes in its own album, not the day's photos. */
  booth?: boolean
  /** Told the upload's id once minted, so it can be removed later. */
  onMediaId?: (mediaId: string) => void
  /** Local preview while it uploads (object URL). */
  preview?: string
  /** The server's id for it, once minted. */
  mediaId?: string
  /** The guest removed it mid-upload: delete it the moment it lands. */
  discard?: boolean
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

/**
 * This phone's id, kept for the event whoever the guest says they are:
 * the name a phone holds is tied to it, so switching names and back must
 * not mint a new one.
 */
function deviceIdFor(eventIdentifier: string): string {
  const key = `event_media_device:${eventIdentifier}`
  const fresh = () => (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
    }))
  try {
    let id = localStorage.getItem(key)
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      // An older phone already has an id inside its saved guest.
      const saved = JSON.parse(localStorage.getItem(`event_media_guest:${eventIdentifier}`) || 'null')
      id = saved && typeof saved.client_id === 'string' ? saved.client_id : fresh()
      localStorage.setItem(key, id!)
    }
    return id!
  } catch {
    return fresh()
  }
}

/** Fetch an image and hold it as a data URL; null if that fails. */
async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    if (!blob.type.startsWith('image/')) return null
    return await new Promise<string | null>((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(typeof r.result === 'string' ? r.result : null)
      r.onerror = () => resolve(null)
      r.readAsDataURL(blob)
    })
  } catch {
    return null
  }
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

/**
 * What a phone shows before the page's own code has run: a full-screen
 * cover in the upload screen's colours, so the event page underneath
 * does not flash up first. It is the Suspense fallback, which the server
 * renders into the HTML -- the page itself reads the URL, so it can only
 * render in the browser. Phones only: a desktop visitor to the photos tab
 * without an upload code should just see the event page.
 */
const COVER_CSS = `
.em-cover{display:none}
@media (max-width:767px){.em-cover{display:flex;position:fixed;inset:0;z-index:60;align-items:center;justify-content:center;
  background:radial-gradient(120% 80% at 50% -10%,#2a2140 0%,#141019 55%,#0b0a0f 100%)}}
.em-cover i{width:34px;height:34px;border-radius:50%;border:3px solid rgba(255,255,255,.2);border-top-color:rgba(255,255,255,.85);
  animation:em-spin 900ms linear infinite}
@keyframes em-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.em-cover i{animation:none}}
`

function PhotosCover() {
  return (
    <div className="em-cover" aria-busy="true" aria-label="Loading">
      <style>{COVER_CSS}</style>
      <i />
    </div>
  )
}

export default function GuestPhotosPage(props: Props) {
  return (
    <Suspense fallback={<PhotosCover />}>
      <GuestPhotosInner {...props} />
    </Suspense>
  )
}

function GuestPhotosInner({ eventIdentifier, primaryColor, darkMode }: Props) {
  const searchParams = useSearchParams()

  const codeKey = `event_media_upload_code:${eventIdentifier}`
  const guestKey = `event_media_guest:${eventIdentifier}`

  const [code, setCode] = useState<string | null>(null)
  const [link, setLink] = useState<LinkInfo | null>(null)
  const [loading, setLoading] = useState(true)
  // member_id: the invitation guest they chose, on an event with a list.
  const [guest, setGuest] = useState<{ name: string; client_id: string; member_id?: string | null } | null>(null)
  const [nameInput, setNameInput] = useState('')
  // Said plainly when the server turns this guest away, rather than a row
  // of "retry" links that can never succeed.
  const [uploadNotice, setUploadNotice] = useState<string | null>(null)

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
    /** Which effect is generating, so the picker can show it working. */
    busy: string | null
    error: string | null
    /** The kept copy of `preview` on the server, if it was kept. */
    mediaId?: string | null
  } | null>(null)
  // Can this browser hand a FILE to the share sheet? On iOS that sheet
  // is what puts "Save Image" in front of a guest; long-pressing the
  // preview works too, but nobody finds it. Probed once on mount, never
  // during render: building the probe File can throw in old WebViews,
  // and a throw during render takes the whole page down.
  const [canShareFiles, setCanShareFiles] = useState(false)
  useEffect(() => {
    try {
      const probe = new File([new Uint8Array([0])], 'probe.jpg', { type: 'image/jpeg' })
      setCanShareFiles(Boolean(navigator.canShare?.({ files: [probe] })))
    } catch {
      setCanShareFiles(false)
    }
  }, [])
  // Progress for the generating state. `finishing` keeps the bar on
  // screen just long enough to run to 100% when the picture lands,
  // rather than snapping away mid-stride.
  const [boothProgress, setBoothProgress] = useState(0)
  const [boothStatus, setBoothStatus] = useState(0)
  const [boothFinishing, setBoothFinishing] = useState(false)
  // Read here, next to the state it drives; the timers that use it live
  // down beside applyEffect, which is what sets `busy` in the first
  // place. Declared ABOVE those effects on purpose — a dependency array
  // is evaluated during render, so naming a const declared lower throws
  // "Cannot access before initialization" and kills the page.
  const boothBusy = shot?.busy ?? null
  const [deleting, setDeleting] = useState<string | null>(null)
  // Top-level section. The booth needs its own tab because it was
  // otherwise invisible: nothing on the upload card hinted it existed,
  // and it only appeared AFTER a guest had already taken a photo with
  // one particular button.
  // ?decade=1980s&look=top-gun opens that booth directly -- a link to
  // send round: "take a photo of yourself in this". Validated against
  // what the event actually offers inside the booth itself.
  const openBoothAt = useMemo(() => {
    const ok = (v: string | null) => (v && /^[a-z0-9][a-z0-9-]{0,40}$/.test(v) ? v : null)
    const era = ok(searchParams.get('decade'))
    const look = ok(searchParams.get('look'))
    return era && look ? { era, look } : null
  }, [searchParams])

  // ?tab=booth opens straight into the photo booth: the booth's own QR.
  const [section, setSection] = useState<'upload' | 'booth'>(
    // A link to one look means the booth, whether or not it says tab=booth.
    () => (searchParams.get('tab') === 'booth' || openBoothAt ? 'booth' : 'upload'),
  )
  // A look chosen before the camera opens, applied as soon as the photo
  // comes back — so the guest picks the result they want, rather than
  // discovering the options afterwards.
  const [pendingExtra, setPendingExtra] = useState<{ pose?: string | null; fingers?: boolean; decade?: string | null } | null>(null)
  const [pendingLook, setPendingLook] = useState<
    { key: string; payload: { filter_id: string } | { effect: string } } | null
  >(null)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  // Separate input from the main camera: this one faces the guest.
  const selfieInputRef = useRef<HTMLInputElement | null>(null)

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
      // Our own other full-screen layers (the illustrated booth) are
      // body children too, and hiding them hid the booth on every phone
      // (harness, 2026-09-21).
      if (el.dataset.eventMediaOverlay !== undefined) continue
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

  /**
   * Everyone's photos, live: every few seconds the newest page is read
   * and anything new goes on the front. Pages already loaded with "Show
   * more" stay put, and a photo that has been removed drops out.
   */
  const refreshGallery = useCallback(async () => {
    if (!code) return
    try {
      const res = await fetch(`${API_BASE}/api/public/event-media/links/${code}/media?${new URLSearchParams({ limit: String(GALLERY_PAGE) })}`)
      if (!res.ok) return
      const data = await res.json()
      const fresh = (data.items ?? []) as GalleryItem[]
      setItems((prev) => {
        const freshIds = new Set(fresh.map((i) => i.id))
        const oldest = fresh[fresh.length - 1]?.created_at
        // Within the span the page covers, the page is the truth.
        const older = prev.filter((i) => !freshIds.has(i.id) && oldest !== undefined && i.created_at < oldest)
        const next = [...fresh, ...older]
        const same = next.length === prev.length && next.every((i, k) => i.id === prev[k]?.id)
        return same ? prev : next
      })
      setNextCursor((c) => c ?? data.next_cursor ?? null)
    } catch {
      // the next tick tries again
    }
  }, [code])

  useEffect(() => {
    if (!link?.settings.show_gallery) return
    loadGallery()
    const interval = setInterval(() => void refreshGallery(), GALLERY_REFRESH_MS)
    return () => clearInterval(interval)
  }, [link, loadGallery, refreshGallery])


  // ── "Yours": the guest's own uploads ──────────────────────────────

  const loadMine = useCallback(async () => {
    if (!code || !guest) return
    setMineLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/public/event-media/links/${code}/mine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // With a guest list, the guest's photos -- whichever phone sent them.
        body: JSON.stringify({ client_id: guest.client_id, ...(guest.member_id ? { member_id: guest.member_id } : {}) }),
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

  /**
   * Remove one of this device's uploads from the event -- the big screen
   * and the gallery included. The server only lets a device remove what
   * it uploaded itself (same check as "Yours").
   */
  const removeUpload = useCallback(async (id: string): Promise<boolean> => {
    if (!code || !guest) return false
    try {
      const res = await fetch(`${API_BASE}/api/public/event-media/links/${code}/mine/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: guest.client_id, media_id: id }),
      })
      if (!res.ok) return false
      setMine((prev) => prev.filter((i) => i.id !== id))
      setItems((prev) => prev.filter((i) => i.id !== id))
      return true
    } catch {
      return false
    }
  }, [code, guest])

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

  // The guest's own uploads, as soon as we know who they are.
  useEffect(() => {
    if (guest) void loadMine()
  }, [guest, loadMine])

  /** The server no longer accepts this name: ask again. */
  const forgetGuest = useCallback(() => {
    setGuest((g) => (g ? { ...g, member_id: null } : g))
    try {
      const raw = localStorage.getItem(guestKey)
      if (raw) localStorage.setItem(guestKey, JSON.stringify({ ...JSON.parse(raw), member_id: null }))
    } catch { /* ignore */ }
  }, [guestKey])

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
          // Always: "Your photos" is the main view of the upload screen.
          void loadMine()
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
              member_id: guest.member_id ?? null,
              client_id: guest.client_id,
              files: batch.map((q) => ({
                filename: q.file.name || 'photo.jpg',
                mime_type: effectiveMime(q.file),
                bytes: q.file.size,
                captured: q.key.startsWith('cam-'),
                booth: Boolean(q.booth),
                prompt: q.prompt ?? null,
              })),
            }),
          })
          mintData = await mintRes.json().catch(() => null)
        } catch {
          mintData = null
        }
        if (!mintData?.items) {
          const why = (mintData as { error?: string; message?: string } | null)
          // Not on the list (any more): back to "Who are you?".
          if (why?.error === 'guest_required' || why?.error === 'name_taken') forgetGuest()
          if (why?.error === 'guest_blocked') setUploadNotice('Uploads are paused for you — please speak to the hosts.')
          batch.forEach((q) => patchItem(q.key, { status: 'failed', error: why?.message ?? 'could not start upload' }))
          // Nothing else in the queue can succeed until that changes.
          if (why?.error === 'guest_required' || why?.error === 'guest_blocked' || why?.error === 'name_taken') break
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
          const mediaId = (minted as { media_id?: unknown }).media_id
          if (typeof mediaId === 'string') {
            q.onMediaId?.(mediaId)
            patchItem(q.key, { mediaId })
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
  }, [code, guest, patchItem, putMinted, flushCompletes, forgetGuest])

  const enqueueFiles = useCallback((
    files: FileList | null,
    camera: boolean,
    booth = false,
    onMediaId?: (mediaId: string) => void,
    prompt?: string | null,
  ) => {
    if (!files || files.length === 0) return
    const stamp = Date.now()
    const fresh: QueueItem[] = Array.from(files).map((file, i) => ({
      key: `${camera ? 'cam' : 'pick'}-${stamp}-${i}-${file.name}`,
      file,
      booth,
      prompt: prompt ?? null,
      onMediaId,
      preview: booth ? undefined : (() => { try { return URL.createObjectURL(file) } catch { return undefined } })(),
      status: 'waiting',
      progress: 0,
    }))
    setQueueSafe((prev) => [...prev, ...fresh])
    void pumpQueue()
  }, [setQueueSafe, pumpQueue])

  /** Remove a tile from "Your photos": cancel, or delete from the event. */
  const removeTile = useCallback(async (t: UploadTile) => {
    const q = queueRef.current.find((x) => x.key === t.key)
    if (q) {
      if (q.status === 'waiting' || q.status === 'failed') {
        if (q.preview) URL.revokeObjectURL(q.preview)
        setQueueSafe((prev) => prev.filter((x) => x.key !== q.key))
        return
      }
      if (q.status !== 'done') {
        // Mid-flight: hidden now, deleted the moment it lands.
        setQueueSafe((prev) => prev.map((x) => (x.key === q.key ? { ...x, discard: true } : x)))
        return
      }
    }
    const id = t.mediaId
    if (id && (await removeUpload(id))) {
      setQueueSafe((prev) => prev.filter((x) => x.mediaId !== id))
    }
  }, [removeUpload, setQueueSafe])

  // Removed mid-upload: once it has landed, take it straight back out.
  useEffect(() => {
    for (const q of queue) {
      if (!q.discard) continue
      if (q.status === 'failed') {
        setQueueSafe((prev) => prev.filter((x) => x.key !== q.key))
      } else if (q.status === 'done' && q.mediaId) {
        const id = q.mediaId
        setQueueSafe((prev) => prev.filter((x) => x.key !== q.key))
        void removeUpload(id)
      }
    }
  }, [queue, removeUpload, setQueueSafe])

  const retryItem = useCallback((key: string) => {
    patchItem(key, { status: 'waiting', progress: 0, error: undefined })
    void pumpQueue()
  }, [patchItem, pumpQueue])

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
    // Nothing to choose between → behave exactly as before.
    const hasBooth = (link?.face_filters?.length ?? 0) > 0 || (link?.booth_effects?.length ?? 0) > 0
    if (!hasBooth) { enqueueFiles(files, true); return }
    const dataUrl = await toDataUrl(file)
    if (!dataUrl) { enqueueFiles(files, true); return }
    setShot({ original: dataUrl, preview: null, filterLabel: null, busy: null, error: null })
  }, [link, enqueueFiles, toDataUrl])

  /**
   * Generate one booth effect. `key` doubles as the busy marker so the
   * picker can show which tile is working; the server takes either a
   * reference-face id or a catalogue effect id, never both.
   */
  const applyEffect = useCallback(async (
    key: string,
    payload: { filter_id: string } | { effect: string },
    extra?: { pose?: string | null; fingers?: boolean; decade?: string | null; place?: string | null },
  ) => {
    if (!code || !guest || !shot) return
    setShot((s) => (s ? { ...s, busy: key, error: null } : s))
    try {
      const res = await fetch(`${API_BASE}/api/public/event-media/links/${code}/booth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Always send the ORIGINAL, never the current preview: effects
        // must not stack on top of one another.
        // A URL back rather than the picture: the server keeps every
        // picture it makes, and handing each back inline is what would
        // have run it out of memory with a room full of guests.
        body: JSON.stringify({
          client_id: guest.client_id,
          guest_name: guest.name,
          member_id: guest.member_id ?? null,
          image: shot.original,
          return: 'url',
          ...payload,
          // What the booth asked them to do, and whether their hand is
          // allowed to change the look.
          ...(extra?.pose ? { pose: extra.pose } : {}),
          ...(extra?.place ? { place: extra.place } : {}),
          ...(extra?.fingers && extra.decade ? { fingers: true, decade: extra.decade } : {}),
        }),
      })
      const data = await res.json().catch(() => null)
      // The picture as a data URL all the same: Save has to hand the
      // bytes to the share sheet synchronously, inside the tap.
      let image: string | null = typeof data?.image === 'string' ? data.image : null
      if (res.ok && !image && typeof data?.image_url === 'string') image = await fetchAsDataUrl(data.image_url)
      if (!res.ok || !image) {
        setShot((s) => (s ? {
          ...s,
          busy: null,
          error: data?.message ?? 'that one did not work — you can still upload your photo',
        } : s))
        return
      }
      setShot((s) => (s ? {
        ...s,
        busy: null,
        preview: image,
        filterLabel: data.effect?.label ?? data.filter?.label ?? null,
        // 1-5 when the booth read a hand and changed the look to match.
        fingers: typeof data?.fingers === 'number' && data.fingers >= 1 && data.fingers <= 5 ? data.fingers : null,
        mediaId: typeof data?.media_id === 'string' ? data.media_id : null,
      } : s))
    } catch {
      setShot((s) => (s ? { ...s, busy: null, error: 'could not reach the photo booth' } : s))
    }
  }, [code, guest, shot])

  // Drive the progress bar and the rotating status line for as long as
  // applyEffect is working. Nothing here talks to the server — there is
  // no progress to read — so it is purely a clock.
  useEffect(() => {
    if (!boothBusy) return
    setBoothFinishing(false)
    setBoothStatus(0)
    setBoothProgress(4)
    const started = Date.now()
    const iv = setInterval(() => {
      const elapsed = Date.now() - started
      setBoothProgress(4 + (BOOTH_CEILING - 4) * (1 - Math.exp(-elapsed / BOOTH_TAU_MS)))
      setBoothStatus(Math.min(BOOTH_STATUS.length - 1, Math.floor(elapsed / BOOTH_STATUS_MS)))
    }, 120)
    // Cleanup runs the moment the picture lands (or fails), which is the
    // only honest signal we get that it is done — so that is where the
    // bar is allowed to reach 100%.
    return () => {
      clearInterval(iv)
      setBoothProgress(100)
      setBoothFinishing(true)
    }
  }, [boothBusy])

  // Hold the finished bar on screen briefly, so it visibly completes
  // instead of vanishing mid-stride.
  useEffect(() => {
    if (!boothFinishing) return
    const t = setTimeout(() => setBoothFinishing(false), 500)
    return () => clearTimeout(t)
  }, [boothFinishing])

  /** Upload whichever version the guest settled on. */
  /**
   * Upload a picture held as a data URL -- the current shot, or one the
   * booth's carousel kept from earlier. Booth-made pictures go to the
   * booth's album; an untouched photo goes wherever uploads go.
   */
  const postImage = useCallback(async (
    dataUrl: string,
    fromBooth: boolean,
    onMediaId?: (mediaId: string) => void,
  ) => {
    const blob = await (await fetch(dataUrl)).blob()
    const name = fromBooth ? `filtered-${Date.now()}.jpg` : `photo-${Date.now()}.jpg`
    const file = new File([blob], name, { type: 'image/jpeg' })
    const dt = new DataTransfer()
    dt.items.add(file)
    enqueueFiles(dt.files, true, fromBooth, onMediaId)
  }, [enqueueFiles])

  /** Put a booth picture the server already kept onto the big screen. */
  const postKept = useCallback(async (mediaId: string): Promise<boolean> => {
    if (!code || !guest) return false
    try {
      const res = await fetch(`${API_BASE}/api/public/event-media/links/${code}/booth/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: guest.client_id, media_id: mediaId }),
      })
      return res.ok
    } catch {
      return false
    }
  }, [code, guest])

  /** Take a booth picture back off the big screen. */
  const unpostKept = useCallback(async (mediaId: string): Promise<boolean> => {
    if (!code || !guest) return false
    try {
      const res = await fetch(`${API_BASE}/api/public/event-media/links/${code}/booth/unpost`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: guest.client_id, media_id: mediaId }),
      })
      return res.ok
    } catch {
      return false
    }
  }, [code, guest])

  const acceptShot = useCallback(async () => {
    if (!shot) return
    // A kept booth picture is posted, not uploaded a second time.
    if (shot.preview && shot.mediaId && (await postKept(shot.mediaId))) {
      setShot(null)
      return
    }
    await postImage(shot.preview ?? shot.original, Boolean(shot.preview))
    setShot(null)
  }, [shot, postImage, postKept])

  /**
   * Keep whichever version is on screen.
   *
   * Synchronous on purpose, right down to navigator.share(). Safari only
   * honours share() while the tap's user activation is still live, and
   * an awaited fetch() of the data URL can outlive it — so the bytes are
   * decoded here rather than fetched. Both `original` (canvas
   * toDataURL) and `preview` (the booth API) are data URLs, so there is
   * nothing to go to the network for anyway.
   */
  const saveImage = useCallback((source: string): boolean => {
    let file: File | null = null
    try {
      // Both sources are data: URLs by construction (canvas toDataURL,
      // and the booth API's base64 payload), but the booth response is
      // only `res.json()` with no shape check behind it, so prove it
      // rather than assume it.
      if (!source.startsWith('data:')) return false
      const comma = source.indexOf(',')
      if (comma < 0) return false
      const meta = source.slice(0, comma)
      // Allowlisted, not taken as given: the media type ends up on a File
      // handed to the OS share sheet, and the only thing that should ever
      // reach the camera roll from here is a picture.
      const declared = /^data:([a-z]+\/[a-z0-9.+-]+)/i.exec(meta)?.[1]?.toLowerCase()
      const type = declared && BOOTH_SAVE_TYPES[declared] ? declared : 'image/jpeg'
      // Named after the EVENT, not a couple: every tenant installs this
      // module, and a hardcoded name would put one wedding's branding on
      // every other event's downloads.
      const stem = (link?.event?.slug || link?.event?.identifier || eventIdentifier || 'photo')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'photo'
      const name = `${stem}-${Date.now()}.${BOOTH_SAVE_TYPES[type]}`
      const body = source.slice(comma + 1)
      const binary = meta.includes(';base64') ? atob(body) : decodeURIComponent(body)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      file = new File([bytes], name, { type })
    } catch {
      setShot((s) => (s ? { ...s, error: 'could not save that one — you can still upload it' } : s))
      return false
    }
    if (canShareFiles) {
      // A cancelled share sheet (AbortError) is the guest changing their
      // mind, NOT a failure: falling through to the download would leave
      // them with a file they just declined. Either way we are done.
      try {
        void navigator.share({ files: [file] }).catch(() => {})
      } catch {
        // Nothing useful to say — the sheet simply did not open.
      }
      return true
    }
    // Desktop and anything without file sharing: a plain download.
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Revoked on a delay: revoking straight away races the browser's own
    // read of the blob in some WebViews and saves a zero-byte file.
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    return true
  }, [canShareFiles, link, eventIdentifier])

  const saveShot = useCallback(() => {
    if (shot) saveImage(shot.preview ?? shot.original)
  }, [shot, saveImage])

  // ── Photo booth ───────────────────────────────────────────────────

  /** Open the front camera, remembering the look to apply afterwards. */
  const openBooth = useCallback((look: typeof pendingLook) => {
    setPendingLook(look)
    selfieInputRef.current?.click()
  }, [])

  const onSelfieShot = useCallback(async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) { setPendingLook(null); return }
    const dataUrl = await toDataUrl(file)
    // If the photo cannot be read (an unusual format, say), fall back to
    // a plain upload rather than dropping the guest's picture.
    if (!dataUrl) { setPendingLook(null); enqueueFiles(files, true); return }
    setShot({ original: dataUrl, preview: null, filterLabel: null, busy: null, error: null })
  }, [toDataUrl, enqueueFiles])

  // The illustrated booth hands back a picture it took itself, from the
  // live camera in its window, and goes through the same look-then-apply
  // path as the camera app does.
  const onBoothCaptured = useCallback((dataUrl: string, look: BoothLook | null) => {
    setPendingExtra(look
      ? { pose: look.pose ?? null, fingers: look.fingers === true, decade: look.decade ?? null, place: look.place ?? null }
      : null)
    setPendingLook(look ? { key: look.key, payload: look.payload } : null)
    setShot({ original: dataUrl, preview: null, filterLabel: null, busy: null, error: null })
  }, [])

  const onBoothFallback = useCallback((look: BoothLook | null) => {
    openBooth(look ? { key: look.key, payload: look.payload } : null)
  }, [openBooth])

  // Apply the chosen look once the shot is in state. Done here rather
  // than inside onSelfieShot because applyEffect reads `shot`, which is
  // still null at the moment setShot is called.
  useEffect(() => {
    if (!shot || !pendingLook || shot.busy || shot.preview) return
    const look = pendingLook
    const extra = pendingExtra
    setPendingLook(null)
    setPendingExtra(null)
    void applyEffect(look.key, look.payload, extra ?? undefined)
  }, [shot, pendingLook, pendingExtra, applyEffect])

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
    const next = {
      name,
      // This phone's own id, the same whatever name it gives.
      client_id: deviceIdFor(eventIdentifier),
    }
    setGuest(next)
    try { localStorage.setItem(guestKey, JSON.stringify(next)) } catch { /* private mode */ }
  }, [nameInput, eventIdentifier, guestKey])

  /** A name chosen from the invitation list. */
  /**
   * A name chosen from the invitation list -- claimed for this phone on
   * the server, so nobody else can choose it. Resolves to an error message
   * for the picker to show, or null once it is theirs.
   */
  const pickGuest = useCallback(async (g: { id: string; name: string }): Promise<string | null> => {
    if (!code) return 'Something went wrong — try again.'
    const clientId = deviceIdFor(eventIdentifier)
    try {
      const res = await fetch(`${API_BASE}/api/public/event-media/links/${code}/guests/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, member_id: g.id }),
      })
      const body = await res.json().catch(() => null)
      if (res.status === 409) return `${g.name} has already been chosen on another phone. If that's you, please ask the hosts.`
      if (res.status === 403) return 'Uploads are paused for this guest — please speak to the hosts.'
      if (!res.ok) return body?.message ?? 'Could not choose that name — try again.'
    } catch {
      return 'No connection — try again in a moment.'
    }
    const next = { name: g.name, member_id: g.id, client_id: clientId }
    setGuest(next)
    try { localStorage.setItem(guestKey, JSON.stringify(next)) } catch { /* private mode */ }
    return null
  }, [code, eventIdentifier, guestKey])

  /** "Not you?": let the name go, so its real owner can choose it. */
  const notMe = useCallback(() => {
    const was = guest
    if (code && was?.member_id) {
      void fetch(`${API_BASE}/api/public/event-media/links/${code}/guests/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: was.client_id, member_id: was.member_id }),
      }).catch(() => { /* the organiser can release it */ })
    }
    setGuest(null)
    setMine([])
    setNameInput('')
    try { localStorage.removeItem(guestKey) } catch { /* ignore */ }
  }, [code, guest, guestKey])

  /**
   * The pose the whole party is being asked for, with the time left in
   * this one -- shown on the photos tab as well as in the booth, so a
   * guest sees it without opening anything (asked 2026-09-22).
   */
  const posesPayload = link?.booth?.poses ?? null
  const [poseTick, setPoseTick] = useState(() => Date.now())
  useEffect(() => {
    if (posesPayload?.mode !== 'hour') return
    const t = setInterval(() => setPoseTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [posesPayload?.mode])
  // When the slot turns over, ask the server for the new pose.
  useEffect(() => {
    if (posesPayload?.mode !== 'hour' || !posesPayload.changes_at || !code) return
    const due = new Date(posesPayload.changes_at).getTime() - Date.now()
    const t = setTimeout(() => {
      // Just the pose: the rest of the link has not changed.
      fetch(`${API_BASE}/api/public/event-media/links/${code}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.booth?.poses) setLink((l) => (l && l.booth ? { ...l, booth: { ...l.booth, poses: data.booth.poses } } : l))
        })
        .catch(() => { /* the next slot tries again */ })
    }, Math.max(1000, due + 1500))
    return () => clearTimeout(t)
  }, [posesPayload, code])
  const posePrompt = (() => {
    const p = posesPayload
    if (!p || p.mode !== 'hour' || !p.current) return null
    let countdown: string | null = null
    if (p.changes_at) {
      const left = Math.max(0, new Date(p.changes_at).getTime() - poseTick)
      countdown = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`
    }
    return { label: p.current.label, instruction: p.current.instruction, countdown, next: p.next?.label ?? null }
  })()

  /**
   * The morning before the event: a countdown and a handful of things to
   * photograph. The asks answered on this phone are remembered so they
   * can be ticked off (and so the list keeps moving through the day).
   */
  const readyPayload = link?.ready?.active ? link.ready : null
  const [askedDone, setAskedDone] = useState<string[]>([])
  useEffect(() => {
    if (!readyPayload) return
    try {
      const saved = JSON.parse(localStorage.getItem(`event_media_asks:${eventIdentifier}`) || '[]')
      if (Array.isArray(saved)) setAskedDone(saved.filter((x) => typeof x === 'string'))
    } catch { /* private mode */ }
  }, [readyPayload, eventIdentifier])
  const [readyTick, setReadyTick] = useState(() => Date.now())
  useEffect(() => {
    if (!readyPayload) return
    const t = setInterval(() => setReadyTick(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [readyPayload])
  const readyProps = (() => {
    if (!readyPayload?.starts_at) return null
    const left = Date.parse(readyPayload.starts_at) - readyTick
    if (!Number.isFinite(left) || left <= 0) return null
    const hours = Math.floor(left / 3_600_000)
    const mins = Math.floor((left % 3_600_000) / 60_000)
    const countdown = hours >= 1
      ? `${hours} hour${hours === 1 ? '' : 's'} ${mins} min to go`
      : `${mins} minute${mins === 1 ? '' : 's'} to go`
    return { countdown, prompts: readyPayload.prompts, done: askedDone }
  })()

  const onPrompt = useCallback((prompt: { id: string; camera: 'user' | 'environment' }, files: FileList) => {
    setUploadNotice(null)
    enqueueFiles(files, true, false, undefined, prompt.id)
    setAskedDone((done) => {
      const next = done.includes(prompt.id) ? done : [...done, prompt.id]
      try { localStorage.setItem(`event_media_asks:${eventIdentifier}`, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [enqueueFiles, eventIdentifier])

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
    // With an upload code on the way in, keep covering until the screen is
    // ready. The URL, not the `code` state: state is only filled in after
    // the first render, and the first render is the one the server sends
    // -- it is the render that has to cover the event page.
    const urlCode = searchParams.get('u')
    if (code || (urlCode && /^[a-z0-9]{6,16}$/.test(urlCode))) return <PhotosCover />
    return <div className={`p-8 text-center ${subText}`}>Loading…</div>
  }

  const canUpload = Boolean(code && link)
  canUploadRef.current = canUpload
  // With an invitation list the name must come from it; a name typed on
  // this device before the list existed does not count.
  const needsName = canUpload && (link!.settings.guest_list
    ? !guest?.member_id
    : link!.settings.require_name && !guest)
  const activeCount = queue.filter((q) => q.status === 'waiting' || q.status === 'uploading' || q.status === 'processing').length
  const failedItems = queue.filter((q) => q.status === 'failed')

  const boothFaces = link?.face_filters ?? []
  const boothStyles = link?.booth_effects ?? []
  // The booth turns itself on only when the deployment has a provider
  // and this link opts in; with neither, the tab never appears and the
  // page behaves exactly as it did before.
  const boothOpen = canUpload && !needsName && (boothFaces.length > 0 || boothStyles.length > 0)
  const activeSection = boothOpen ? section : 'upload'
  // With a theme, the booth is a place you walk into rather than a card:
  // full screen, over everything, on phones and desktops alike.
  const boothTheme = link?.booth && link.booth.eras.length > 0 ? link.booth : null
  const immersiveBooth = activeSection === 'booth' && Boolean(boothTheme) && mounted

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
      {/* Section tabs — the booth's shopfront. Without this the feature
          is invisible until after a photo has already been taken. */}
      {boothOpen && (
        <div className="flex gap-2 mb-4">
          {([
            ['upload', 'Add photos'],
            ['booth', 'Photo booth'],
          ] as const).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setSection(val)}
              className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
                activeSection === val
                  ? 'text-white'
                  : darkMode ? 'bg-white/10 text-white/80' : 'bg-black/5 text-gray-700'
              }`}
              style={activeSection === val ? { backgroundColor: primaryColor } : undefined}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Upload bar */}
      {canUpload && activeSection === 'upload' && (
        <div className={`${cardBg} rounded-2xl shadow p-5 mb-6`}>
          {needsName ? (
            <div>
              <h2 className={`text-lg font-semibold mb-1 ${text}`}>
                {link!.settings.guest_list ? 'Who are you?' : 'Add your photos'}
              </h2>
              {link!.settings.guest_list ? (
                <GuestPicker code={code!} darkMode={darkMode} onPick={pickGuest} />
              ) : (
              <>
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
              </>
              )}
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
              {uploadNotice && (
                <p role="alert" className="mb-3 rounded-lg bg-amber-100 text-amber-900 text-sm px-3 py-2">{uploadNotice}</p>
              )}
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

      {/* Photo booth — pick the look first, then the camera opens. With
          a theme the illustrated booth replaces this card entirely, so
          nothing under it can widen the page (below). */}
      {activeSection === 'booth' && !immersiveBooth && (
        <div className={`${cardBg} rounded-2xl shadow p-5 mb-6`}>
          <h2 className={`text-lg font-semibold mb-1 ${text}`}>Photo booth</h2>
          <p className={`text-sm mb-4 ${subText}`}>
            Pick a look and take a selfie. You&apos;ll see the result before anything is shared,
            and you can always keep your original.
          </p>

          {boothFaces.length > 0 && (
            <div className="flex flex-wrap gap-4 mb-5">
              {boothFaces.map((f) => (
                <button
                  key={f.id}
                  onClick={() => openBooth({ key: `filter:${f.id}`, payload: { filter_id: f.id } })}
                  className="flex flex-col items-center gap-1.5 w-20"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- reference face */}
                  <img
                    src={f.preview}
                    alt=""
                    className="w-16 h-16 rounded-full object-cover border-2"
                    style={{ borderColor: primaryColor }}
                  />
                  <span className={`text-xs font-medium ${text}`}>Be {f.label}</span>
                </button>
              ))}
            </div>
          )}

          {boothStyles.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {boothStyles.map((e) => (
                <button
                  key={e.id}
                  onClick={() => openBooth({ key: e.id, payload: { effect: e.id } })}
                  className={`rounded-xl px-3 py-2.5 text-left ring-1 ${
                    darkMode ? 'bg-white/10 ring-white/20' : 'bg-black/5 ring-black/10'
                  }`}
                >
                  <span className={`block text-sm font-medium leading-tight ${text}`}>{e.label}</span>
                  <span className={`block text-[11px] leading-tight mt-0.5 ${subText}`}>{e.blurb}</span>
                </button>
              ))}
            </div>
          )}

          <button
            onClick={() => openBooth(null)}
            className={`mt-4 text-sm underline ${subText}`}
          >
            Or just take a selfie and choose after
          </button>

        </div>
      )}

      {/* The front-camera input, mounted whenever the booth is open --
          the plain card's looks and the illustrated booth's "use your
          camera app" fallback both open it. Inline display:none rather
          than a utility class, so it cannot depend on the portal's CSS. */}
      {activeSection === 'booth' && (
        <input
          ref={selfieInputRef}
          type="file"
          accept="image/*"
          capture="user"
          style={{ display: 'none' }}
          onChange={(e) => { onSelfieShot(e.target.files); e.target.value = '' }}
        />
      )}

      {!canUpload && (
        <div className={`${cardBg} rounded-2xl shadow p-5 mb-6`}>
          <p className={`text-sm ${subText}`}>
            Scan the event&apos;s photo QR code to add your own photos here.
          </p>
        </div>
      )}

      {/* Gallery */}
      {link?.settings.show_gallery && activeSection === 'upload' && (
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
      {shot && !immersiveBooth && (
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
            {shot.preview && !shot.busy && (
              <p className="text-white/70 text-sm">
                {shot.filterLabel ?? 'Done'} — happy with it?
              </p>
            )}
            {(shot.busy || boothFinishing) && (
              <div className="space-y-2" aria-live="polite">
                <div
                  className="relative h-1 w-full rounded-full overflow-hidden"
                  style={{ backgroundColor: 'rgba(255,255,255,0.15)' }}
                  role="progressbar"
                  aria-label="Making your picture"
                >
                  <div
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                      width: `${boothProgress}%`,
                      backgroundColor: primaryColor,
                      transition: 'width 240ms linear',
                    }}
                  />
                  {shot.busy && (
                    <div
                      className="booth-sheen absolute inset-y-0 w-1/4"
                      style={{
                        background:
                          'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0) 100%)',
                        animation: 'booth-sheen 1.6s ease-in-out infinite',
                      }}
                    />
                  )}
                </div>
                <p
                  key={boothStatus}
                  className="booth-say text-white/70 text-sm"
                  style={{ animation: 'booth-say 420ms ease-out both' }}
                >
                  {shot.busy ? BOOTH_STATUS[boothStatus] : 'Here you go…'}
                </p>
              </div>
            )}

            {/* Reference faces first — they are the ones with a picture
                to show. Styles follow as labelled tiles. */}
            {(link?.face_filters?.length ?? 0) > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {(link?.face_filters ?? []).map((f) => (
                  <button
                    key={f.id}
                    onClick={() => applyEffect(`filter:${f.id}`, { filter_id: f.id })}
                    disabled={shot.busy !== null}
                    className="flex-shrink-0 flex flex-col items-center gap-1 disabled:opacity-40"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- reference face */}
                    <img
                      src={f.preview}
                      alt=""
                      className={`w-14 h-14 rounded-full object-cover ring-2 ${
                        shot.busy === `filter:${f.id}` ? 'ring-white animate-pulse' : 'ring-white/30'
                      }`}
                    />
                    <span className="text-white/80 text-xs">Be {f.label}</span>
                  </button>
                ))}
              </div>
            )}

            {(link?.booth_effects?.length ?? 0) > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {(link?.booth_effects ?? []).map((e) => (
                  <button
                    key={e.id}
                    onClick={() => applyEffect(e.id, { effect: e.id })}
                    disabled={shot.busy !== null}
                    className={`rounded-lg px-2 py-2 text-left ring-1 disabled:opacity-40 ${
                      shot.busy === e.id
                        ? 'bg-white/20 ring-white animate-pulse'
                        : 'bg-white/10 ring-white/20'
                    }`}
                  >
                    <span className="block text-white text-xs font-medium leading-tight">{e.label}</span>
                    <span className="block text-white/50 text-[10px] leading-tight mt-0.5">{e.blurb}</span>
                  </button>
                ))}
              </div>
            )}

            {shot.preview && (
              <button
                onClick={() => setShot((s) => (s ? { ...s, preview: null, filterLabel: null } : s))}
                disabled={shot.busy !== null}
                className="text-white/60 text-xs underline disabled:opacity-40"
              >
                Back to my original photo
              </button>
            )}

            {/* The two ways to keep the picture share a row; backing out
                gets its own. Three across does not fit 390px: every
                label wraps to two lines and the row turns to mush. */}
            <div className="flex gap-2">
              <button
                onClick={acceptShot}
                disabled={shot.busy !== null}
                className="flex-1 rounded-lg px-4 py-2.5 font-medium text-white disabled:opacity-50"
                style={{ backgroundColor: primaryColor }}
              >
                {shot.preview ? 'Upload this one' : 'Upload photo'}
              </button>
              <button
                onClick={saveShot}
                disabled={shot.busy !== null}
                className="flex-1 rounded-lg px-4 py-2.5 text-white/80 bg-white/10 ring-1 ring-white/20 disabled:opacity-50"
              >
                Save to my photos
              </button>
            </div>
            <button
              onClick={() => setShot(null)}
              disabled={shot.busy !== null}
              className="w-full rounded-lg px-4 py-2.5 text-white/60 bg-white/5 ring-1 ring-white/10 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          <style>{BOOTH_KEYFRAMES}</style>
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

  // ── The wedding-photos screen (UploadApp) ─────────────────────────
  // "Your photos": what is uploading now, then what the server has.
  // Booth pictures are the booth's own business, so they stay out.
  const mineIds = new Set(mine.map((m) => m.id))
  const uploadTiles: UploadTile[] = [
    ...queue
      .filter((q) => !q.booth && !q.discard && !(q.mediaId && mineIds.has(q.mediaId)))
      .slice()
      .reverse()
      .map((q) => ({
        key: q.key,
        src: q.preview ?? '',
        isVideo: effectiveMime(q.file).startsWith('video/'),
        state: q.status,
        progress: q.progress,
        error: q.error,
        mediaId: q.mediaId ?? null,
      })),
    ...mine
      .filter((m) => !(m as { album?: string }).album || (m as { album?: string }).album !== 'booth')
      .map((m) => ({
        key: m.id,
        src: m.variants?.thumb || m.url,
        full: m.variants?.medium || m.url,
        isVideo: m.kind === 'video',
        state: (m.pending ? 'pending' : 'done') as UploadTile['state'],
        progress: 100,
        mediaId: m.id,
      })),
  ]

  const nameStep = needsName ? (
    <div>
      <p className="ua-h1" style={{ fontSize: 26 }}>{link!.settings.guest_list ? 'Who are you?' : 'Add your photos'}</p>
      <p className="ua-sub" style={{ marginBottom: 12 }}>
        {link!.settings.guest_list
          ? 'Find your name so your photos are yours.'
          : 'Tell us your name once — it’s remembered on this device.'}
      </p>
      {link!.settings.guest_list ? (
        <GuestPicker code={code!} darkMode clientId={deviceIdFor(eventIdentifier)} onPick={pickGuest} />
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveName() }}
            placeholder="Your name"
            maxLength={80}
            style={{ flex: 1, borderRadius: 10, border: '1px solid #ccc', padding: '10px 12px', color: '#111', fontSize: 16 }}
          />
          <button type="button" onClick={saveName} disabled={!nameInput.trim()}
            style={{ borderRadius: 10, padding: '0 16px', color: '#fff', fontWeight: 700, backgroundColor: primaryColor, opacity: nameInput.trim() ? 1 : 0.5 }}>
            That&apos;s me
          </button>
        </div>
      )}
    </div>
  ) : null

  const uploadApp = canUpload && mounted && activeSection === 'upload' ? createPortal(
    <UploadApp
      eventName={link!.event.name ?? 'Event photos'}
      pose={posePrompt}
      ready={readyProps}
      onPrompt={onPrompt}
      primaryColor={primaryColor}
      nameStep={nameStep}
      guestName={guest?.name ?? null}
      onNotMe={notMe}
      allowVideo={link!.settings.allow_video}
      tiles={uploadTiles}
      onAdd={(files) => { setUploadNotice(null); enqueueFiles(files, false) }}
      onDelete={(t) => void removeTile(t)}
      onRetry={(t) => retryItem(t.key)}
      notice={uploadNotice}
      onOpenBooth={boothOpen ? () => setSection('booth') : null}
      showGallery={Boolean(link!.settings.show_gallery)}
      everyone={items}
      hasMore={Boolean(nextCursor)}
      loadingMore={galleryLoading}
      onLoadMore={() => loadGallery(nextCursor)}
    />,
    document.body,
  ) : null

  const booth = immersiveBooth ? createPortal(
    <BoothExperience
      booth={boothTheme!}
      effects={boothStyles}
      faces={boothFaces}
      shot={shot}
      progress={boothProgress}
      statusText={shot?.busy ? BOOTH_STATUS[boothStatus] : 'Here you go…'}
      generating={Boolean(shot?.busy) || boothFinishing}
      primaryColor={primaryColor}
      openAt={openBoothAt}
      onCaptured={onBoothCaptured}
      onFallbackCamera={onBoothFallback}
      onAccept={acceptShot}
      onSave={saveShot}
      onDiscard={() => { setPendingLook(null); setShot(null) }}
      onOriginal={() => setShot((s) => (s ? { ...s, preview: null, filterLabel: null } : s))}
      onClose={() => { setPendingLook(null); setShot(null); setSection('upload') }}
      historyKey={`booth:${eventIdentifier}`}
      onPostImage={postImage}
      onSaveImage={saveImage}
      onRemoveUpload={removeUpload}
      onPostKept={postKept}
      onUnpostKept={unpostKept}
    />,
    document.body,
  ) : null

  // The upload screen is the whole page while it is up.
  if (uploadApp) return <>{uploadApp}{booth}</>

  if (mobileTakeover) {
    return <>{createPortal(
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
    )}{booth}</>
  }

  return <>{pageContent}{booth}</>
}
