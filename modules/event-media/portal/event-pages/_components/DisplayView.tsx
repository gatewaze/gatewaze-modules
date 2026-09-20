'use client'

// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * Projector display view — full-bleed live gallery/slideshow of an
 * event's guest photos, with an optional live-camera layer on top.
 *
 * Rendered by the photos event tab when `?display=1` is present:
 *   /events/<identifier>/photos?u=<code>&display=1
 * (A standalone module portal page is NOT used — module pages under
 * /m/[...path] are gated on portal-nav visibility, which event-media
 * deliberately doesn't have; evidence review 2026-09-19, F1.)
 *
 * - Photos only, ever (server filter=photo + defensive client check).
 * - The photo montage NEVER stops running underneath; the live camera
 *   feed is a layer above it that fades in when a stream exists and
 *   out when it dies — the projector never shows a black screen.
 * - Liveness: 10 s incremental poll (primary) + supabase realtime
 *   INSERT channel (accelerator; silently absent when unavailable).
 * - Live sources: WHEP from MediaMTX on this laptop (auto-switchover
 *   via its localhost control API), a local UVC webcam, or an unlisted
 *   YouTube embed (manual only).
 *
 * Per spec-event-media-guest-uploads §6.3 + §15.4.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import CinematicPhoto from './CinematicPhoto'
import { extractPalette, type PhotoPalette } from './_lib/photo-fx'

// Same-origin — proxied to the api service by the portal's
// /api/public/* rewrite (see photos.tsx note).
const API_BASE = ''
const POLL_MS = 10_000
const MAX_PHOTOS = 500
const MENU_HIDE_MS = 4_000
const LIVE_STATUS_POLL_MS = 2_000
// Cadence once the stream host looks absent (see the poll loop).
const LIVE_STATUS_SLOW_MS = 20_000
const LIVE_DEAD_MS = 4_000
const DEFAULT_WHEP_URL = 'http://localhost:8889/live/whep'
const DEFAULT_STATUS_URL = 'http://localhost:9997/v3/paths/get/live'

interface DisplayItem {
  id: string
  kind: string
  url: string
  variants: Record<string, string>
  guest_name: string | null
  created_at: string
}

type SlideEffect = 'cinematic' | 'kenburns' | 'grade' | 'fade' | 'slide' | 'zoom' | 'blur'

interface DisplaySettings {
  mode: 'slideshow' | 'wall'
  intervalMs: number
  effect: SlideEffect
  qrMode: 'corner' | 'interleave' | 'hidden'
  qrEveryN: number
  liveSource: 'whep' | 'webcam' | 'youtube'
  liveOverride: 'auto' | 'live' | 'photos'
  whepUrl: string
  statusUrl: string
  youtubeId: string
  /** Ambient colour spill: the room's light follows the photo. */
  ambient: boolean
  /** Fill 16:9 letterbox bars with a blurred copy of the photo. */
  fillBars: boolean
  /** Background-melt half of the cinematic effect. */
  /** How pronounced the 3D relief is. 0 is a flat camera move. */
  depthStrength: number
  /** @deprecated cinematic is GPU-only; kept so stored settings parse. */
  subjectPop: boolean
  /** Opt-in GPU backend for the models (see ai-pipeline note). */
  /** @deprecated drove the ML backend, which cinematic no longer uses. */
  webgpu: boolean
  /** Rotation order through the pool. */
  order: 'newest' | 'oldest' | 'shuffle'
  /**
   * Cut to a photo the moment it lands instead of waiting for the
   * current slide to run out — a guest sees their upload appear while
   * they are still holding the phone.
   */
  instantNew: boolean
}

const DEFAULT_SETTINGS: DisplaySettings = {
  mode: 'slideshow',
  intervalMs: 8000,
  effect: 'kenburns',
  qrMode: 'interleave',
  qrEveryN: 10,
  liveSource: 'whep',
  liveOverride: 'auto',
  whepUrl: DEFAULT_WHEP_URL,
  statusUrl: DEFAULT_STATUS_URL,
  youtubeId: '',
  ambient: true,
  fillBars: true,
  depthStrength: 1,
  subjectPop: true,
  webgpu: false,
  order: 'newest',
  instantNew: true,
}

/**
 * The pool is held newest-first (the feed returns created_at DESC and
 * arrivals are prepended), so 'newest' walks it as-is.
 */
function orderedPool(list: DisplayItem[], order: DisplaySettings['order']): DisplayItem[] {
  if (order === 'oldest') return [...list].reverse()
  return list
}

// Slide-entry animation per effect. Ken Burns additionally runs a slow
// pan/zoom for the WHOLE display interval — the pan direction cycles
// per photo (derived from the photo id) so consecutive slides drift
// differently.
const KB_VARIANTS = ['emkb-a', 'emkb-b', 'emkb-c', 'emkb-d'] as const

function kbVariantFor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h + id.charCodeAt(i)) % 4
  return KB_VARIANTS[h]!
}

function slideAnimation(effect: SlideEffect, photoId: string, intervalMs: number): string {
  const kb = `${kbVariantFor(photoId)} ${Math.max(intervalMs, 2000) + 1200}ms linear forwards`
  switch (effect) {
    case 'kenburns':
      return `emfade 900ms ease, ${kb}`
    case 'grade':
      // Arrives monochrome and blooms into colour, still drifting.
      return `emgrade ${Math.min(2200, Math.max(intervalMs * 0.3, 1200))}ms ease forwards, ${kb}`
    case 'slide':
      return 'emslide 700ms cubic-bezier(0.22, 1, 0.36, 1)'
    case 'zoom':
      return 'emzoom 800ms cubic-bezier(0.22, 1, 0.36, 1)'
    case 'blur':
      return 'emblur 900ms ease'
    default:
      return 'emfade 700ms ease'
  }
}

const EFFECT_KEYFRAMES = `
@keyframes emfade { from { opacity: 0 } to { opacity: 1 } }
@keyframes emslide { from { opacity: 0; transform: translateX(5%) } to { opacity: 1; transform: none } }
@keyframes emzoom { from { opacity: 0; transform: scale(1.12) } to { opacity: 1; transform: scale(1) } }
@keyframes emblur { from { opacity: 0; filter: blur(14px) } to { opacity: 1; filter: none } }
@keyframes emkb-a { from { transform: scale(1.02) } to { transform: scale(1.12) translate(1.5%, -1%) } }
@keyframes emkb-b { from { transform: scale(1.02) } to { transform: scale(1.12) translate(-1.5%, 1%) } }
@keyframes emkb-c { from { transform: scale(1.12) translate(1%, 1%) } to { transform: scale(1.02) } }
@keyframes emkb-d { from { transform: scale(1.02) translate(-1%, 0) } to { transform: scale(1.1) translate(1%, -1.5%) } }
@keyframes emgrade {
  from { opacity: 0; filter: grayscale(1) contrast(1.15) brightness(0.92) }
  40%  { opacity: 1 }
  to   { opacity: 1; filter: none }
}
`

interface WallCell {
  current: DisplayItem | null
  previous: DisplayItem | null
  nextAt: number
}

// Largest exact 16:9-friendly grid the photo count can fill — a
// partially filled last row looks broken on a projector, so counts
// between layouts round DOWN (rotation still cycles every photo in).
const WALL_LAYOUTS: Array<{ cells: number; cols: number; rows: number }> = [
  { cells: 12, cols: 4, rows: 3 },
  { cells: 9, cols: 3, rows: 3 },
  { cells: 8, cols: 4, rows: 2 },
  { cells: 6, cols: 3, rows: 2 },
  { cells: 4, cols: 2, rows: 2 },
  { cells: 3, cols: 3, rows: 1 },
  { cells: 2, cols: 2, rows: 1 },
  { cells: 1, cols: 1, rows: 1 },
]
function wallLayoutFor(count: number) {
  return WALL_LAYOUTS.find((l) => l.cells <= count) ?? WALL_LAYOUTS[WALL_LAYOUTS.length - 1]!
}

/** One labelled settings row. The label sits above its options so a
 *  long option list wraps cleanly instead of clipping off the panel. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs uppercase tracking-wide text-white/50">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

/** Toggle/segment button. Sized for a finger as well as a trackpad. */
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-sm leading-none transition-colors ${
        on ? 'bg-white/90 text-gray-900 font-medium' : 'bg-white/10 text-white/90 hover:bg-white/20'
      }`}
    >
      {children}
    </button>
  )
}

interface DisplayViewProps {
  code: string
}

export default function DisplayView({ code: rawCode }: DisplayViewProps) {
  const code = typeof rawCode === 'string' && /^[a-z0-9]{6,16}$/.test(rawCode) ? rawCode : null

  const settingsKey = `event_media_display:${code ?? ''}`
  const [settings, setSettings] = useState<DisplaySettings>(DEFAULT_SETTINGS)
  const [linkInfo, setLinkInfo] = useState<{ eventId: string | null; logoUrl: string | null; identifier: string | null } | null>(null)
  const [photos, setPhotos] = useState<DisplayItem[]>([])
  const photosRef = useRef<DisplayItem[]>([])
  const freshQueueRef = useRef<DisplayItem[]>([])
  const newestRef = useRef<string | null>(null)

  const [current, setCurrent] = useState<DisplayItem | null>(null)
  /** Bumped when fresh uploads land, to trigger an instant cut. */
  const [freshArrivals, setFreshArrivals] = useState(0)
  /** Bumped on an interrupt so the slide timer restarts cleanly. */
  const [slideTick, setSlideTick] = useState(0)
  const [previous, setPrevious] = useState<DisplayItem | null>(null)
  const [showQrSlide, setShowQrSlide] = useState(false)
  const advanceCountRef = useRef(0)
  const indexRef = useRef(0)

  // Wall mode: a fixed best-fit grid where every cell runs its own
  // mini-slideshow on a staggered clock — cells change at different
  // moments (at most one per tick), each with ±15% period jitter.
  const [wallCells, setWallCells] = useState<WallCell[]>([])
  const wallPointerRef = useRef(0)

  // Ambient colour spill for the current photo.
  const [palette, setPalette] = useState<PhotoPalette | null>(null)

  const [menuVisible, setMenuVisible] = useState(true)
  const menuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  // Live layer state
  const [liveVisible, setLiveVisible] = useState(false)
  const liveVideoRef = useRef<HTMLVideoElement | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const webcamStreamRef = useRef<MediaStream | null>(null)
  const lastFrameAtRef = useRef(0)
  const liveConnectingRef = useRef(false)

  // ── Settings persistence ──────────────────────────────────────────

  useEffect(() => {
    try {
      const raw = localStorage.getItem(settingsKey)
      if (raw) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) })
    } catch { /* defaults are fine */ }
  }, [settingsKey])

  const updateSettings = useCallback((patch: Partial<DisplaySettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      try { localStorage.setItem(settingsKey, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [settingsKey])

  // ── Link + photo feed ─────────────────────────────────────────────

  useEffect(() => {
    if (!code) return
    fetch(`${API_BASE}/api/public/event-media/links/${code}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return
        setLinkInfo({
          eventId: data.event?.id ?? null,
          logoUrl: data.logo_url ?? null,
          identifier: data.event?.identifier ?? null,
        })
      })
      .catch(() => { /* poll retries below */ })
  }, [code])

  const ingest = useCallback((incoming: DisplayItem[], fresh: boolean) => {
    // Defensive: never let a non-photo reach the projector even if the
    // API were to return one.
    const clean = incoming.filter((i) => i.kind === 'photo')
    if (clean.length === 0) return
    setPhotos((prev) => {
      const seen = new Set(prev.map((p) => p.id))
      const add = clean.filter((i) => !seen.has(i.id))
      if (add.length === 0) return prev
      if (fresh) {
        freshQueueRef.current.push(...add)
        // Signal the instant-cut effect (setState during another
        // component's updater is fine here — different state atom,
        // and React batches it into the same commit).
        setFreshArrivals((n) => n + 1)
      }
      const merged = [...add, ...prev].slice(0, MAX_PHOTOS)
      photosRef.current = merged
      const newest = merged[0]?.created_at
      if (newest && (!newestRef.current || newest > newestRef.current)) newestRef.current = newest
      return merged
    })
  }, [])

  useEffect(() => {
    if (!code) return
    let cancelled = false
    const load = async (incremental: boolean) => {
      try {
        const qs = new URLSearchParams({ filter: 'photo', limit: '200' })
        if (incremental && newestRef.current) qs.set('after', newestRef.current)
        const res = await fetch(`${API_BASE}/api/public/event-media/links/${code}/media?${qs}`)
        if (!res.ok || cancelled) return
        const data = await res.json()
        ingest(data.items ?? [], incremental)
      } catch { /* silent — never an error toast mid-reception */ }
    }
    load(false)
    const interval = setInterval(() => load(true), POLL_MS)
    return () => { cancelled = true; clearInterval(interval) }
  }, [code, ingest])

  // Realtime accelerator — best-effort; polling stays the source of truth.
  useEffect(() => {
    if (!code || !linkInfo?.eventId) return
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) return
    let channel: unknown = null
    let client: unknown = null
    let cancelled = false
    import('@supabase/supabase-js')
      .then(({ createClient }) => {
        if (cancelled) return
        client = createClient(url, key)
        channel = client
          .channel(`guest_media_${linkInfo.eventId}`)
          .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'host_media', filter: `host_id=eq.${linkInfo.eventId}` },
            () => {
              // Row payloads are RLS-filtered and may be partial — just
              // trigger an incremental poll instead of trusting them.
              const qs = new URLSearchParams({ filter: 'photo', limit: '50' })
              if (newestRef.current) qs.set('after', newestRef.current)
              fetch(`${API_BASE}/api/public/event-media/links/${code}/media?${qs}`)
                .then((res) => (res.ok ? res.json() : null))
                .then((data) => { if (data) ingest(data.items ?? [], true) })
                .catch(() => { /* poll covers it */ })
            },
          )
          .subscribe()
      })
      .catch(() => { /* realtime unavailable → polling only */ })
    return () => {
      cancelled = true
      try { if (client && channel) client.removeChannel(channel) } catch { /* ignore */ }
    }
  }, [code, linkInfo?.eventId, ingest])

  // ── Slideshow advance ─────────────────────────────────────────────

  const advance = useCallback(() => {
    const fresh = freshQueueRef.current.shift()
    advanceCountRef.current += 1

    // Interleaved QR card every Nth advance.
    setShowQrSlide((prevQr) => {
      if (prevQr) return false
      const due = settings.qrMode === 'interleave' && advanceCountRef.current % Math.max(settings.qrEveryN, 2) === 0
      return due
    })

    setCurrent((prev) => {
      setPrevious(prev)
      // A just-uploaded photo always wins the next slot.
      if (fresh) {
        indexRef.current = 0
        return fresh
      }
      const list = orderedPool(photosRef.current, settings.order)
      if (list.length === 0) return prev
      if (settings.order === 'shuffle' && list.length > 1) {
        // Never repeat the photo that is already up.
        let pick = indexRef.current
        for (let i = 0; i < 8 && pick === indexRef.current; i++) {
          pick = Math.floor(Math.random() * list.length)
        }
        indexRef.current = pick
      } else {
        indexRef.current = (indexRef.current + 1) % list.length
      }
      return list[indexRef.current]
    })
  }, [settings.qrMode, settings.qrEveryN, settings.order])

  useEffect(() => {
    if (settings.mode !== 'slideshow') return
    if (!current && photosRef.current.length > 0) setCurrent(photosRef.current[0])
    const interval = setInterval(advance, Math.max(settings.intervalMs, 2000))
    return () => clearInterval(interval)
    // slideTick restarts the timer after an interrupt so a photo cut to
    // early still gets its full time on screen.
  }, [settings.mode, settings.intervalMs, advance, current, photos.length, slideTick])

  // Cut to new arrivals immediately. The poll finds them within ~10 s;
  // without this they would then wait out the rest of the current
  // slide too, so a guest could stand there for 18 s. One interrupt
  // per burst — the rest of the batch drains through the normal
  // fresh-queue priority rather than strobing past.
  useEffect(() => {
    if (!settings.instantNew || settings.mode !== 'slideshow') return
    if (freshArrivals === 0) return
    advance()
    setSlideTick((t) => t + 1)
  }, [freshArrivals, settings.instantNew, settings.mode, advance])

  // Preload the next slide.
  useEffect(() => {
    const list = photosRef.current
    if (list.length < 2) return
    const next = freshQueueRef.current[0] ?? list[(indexRef.current + 1) % list.length]
    if (next) {
      const img = new window.Image()
      img.src = next.url
    }
  }, [current])

  // ── Wall mode: staggered per-cell slides ──────────────────────────

  useEffect(() => {
    if (settings.mode !== 'wall') return
    const interval = Math.max(settings.intervalMs, 2000)

    const pickNext = (displayed: Set<string>): DisplayItem | null => {
      const list = orderedPool(photosRef.current, settings.order)
      if (list.length === 0) return null
      // Fresh uploads jump straight onto the wall.
      const fresh = freshQueueRef.current.shift()
      if (fresh) return fresh
      if (settings.order === 'shuffle') {
        for (let i = 0; i < 12; i++) {
          const cand = list[Math.floor(Math.random() * list.length)]!
          if (!displayed.has(cand.id)) return cand
        }
      }
      for (let i = 0; i < list.length; i++) {
        wallPointerRef.current = (wallPointerRef.current + 1) % list.length
        const cand = list[wallPointerRef.current]!
        if (!displayed.has(cand.id)) return cand
      }
      return list[wallPointerRef.current] ?? null
    }

    const tick = () => {
      const now = Date.now()
      setWallCells((prev) => {
        const count = photosRef.current.length
        if (count === 0) return prev.length ? [] : prev
        const layout = wallLayoutFor(count)
        if (prev.length !== layout.cells) {
          // (Re)build the grid with staggered clocks so the first
          // round of changes is already spread across the interval.
          const displayed = new Set<string>()
          return Array.from({ length: layout.cells }, (_, i) => {
            const item = pickNext(displayed)
            if (item) displayed.add(item.id)
            return {
              current: item,
              previous: null,
              nextAt: now + Math.round((interval * (i + 1)) / layout.cells) + Math.round(Math.random() * 400),
            }
          })
        }
        // A new upload claims the next cell straight away rather than
        // waiting for that cell's own clock, so the wall reacts as
        // fast as the slideshow does.
        const wantsInstant = settings.instantNew && freshQueueRef.current.length > 0
        const dueIdx = wantsInstant
          ? prev.reduce((oldest, c, i) => (c.nextAt < prev[oldest]!.nextAt ? i : oldest), 0)
          : prev.findIndex((c) => c.nextAt <= now)
        if (dueIdx === -1) return prev
        const displayed = new Set(prev.map((c) => c.current?.id).filter(Boolean) as string[])
        const next = pickNext(displayed)
        if (!next) return prev
        const copy = [...prev]
        const cell = copy[dueIdx]!
        copy[dueIdx] = {
          current: next,
          previous: cell.current,
          nextAt: now + interval + Math.round((Math.random() - 0.5) * interval * 0.3),
        }
        return copy
      })
    }

    tick()
    const iv = setInterval(tick, 500)
    return () => clearInterval(iv)
  }, [settings.mode, settings.intervalMs, settings.order, settings.instantNew])

  // ── Ambient colour spill ──────────────────────────────────────────

  useEffect(() => {
    if (!settings.ambient || !current) { setPalette(null); return }
    let cancelled = false
    const src = current.variants?.thumb || current.url
    void extractPalette(src, current.id).then((p) => {
      if (!cancelled && p) setPalette(p)
    })
    return () => { cancelled = true }
  }, [current, settings.ambient])

  // ── Display-sized sources (cinematic mode) ────────────────────────

  /**
   * Ask the image service for the size the stage will actually show,
   * instead of the camera original. A 4K stage needs ~3840x2160; a
   * phone original is several megabytes of detail that is thrown away
   * on upload to the GPU. Measured on a 1.2 MB original: 422 KB at
   * 2160px, and phone photos on the day will be far larger still.
   *
   * This is the same Supabase render endpoint already used to fill in
   * missing thumbnails, so it needs no new infrastructure.
   */
  const displaySrc = useCallback((item: DisplayItem): string => {
    const url = item.url
    if (!url.includes('/object/public/')) return url
    const dpr = Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 2)
    const w = Math.min(3840, Math.max(1280, Math.round((window.innerWidth || 1920) * dpr)))
    const h = Math.round((w * 9) / 16)
    return `${url.replace('/object/public/', '/render/image/public/')}?width=${w}&height=${h}&resize=contain&quality=82`
  }, [])

  // Fetch the NEXT slide's image during the current one, so the
  // cross-fade always has it decoded and ready.
  useEffect(() => {
    if (settings.effect !== 'cinematic' || !current) return
    const list = photosRef.current
    const upcoming = freshQueueRef.current[0] ?? list[(indexRef.current + 1) % Math.max(list.length, 1)]
    if (!upcoming || upcoming.id === current.id) return
    const warm = new window.Image()
    warm.crossOrigin = 'anonymous'
    warm.src = displaySrc(upcoming)
  }, [current, settings.effect, displaySrc])

  // ── QR overlay ────────────────────────────────────────────────────

  useEffect(() => {
    if (!code || settings.qrMode === 'hidden') { setQrDataUrl(null); return }
    const target = `${window.location.origin}/u/${code}`
    import('qrcode')
      .then((QRCode) => QRCode.toDataURL(target, { width: 512, margin: 1 }))
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null)) // dep unavailable → no QR, page still works
  }, [code, settings.qrMode])

  // ── Live camera layer ─────────────────────────────────────────────

  const teardownLive = useCallback(() => {
    setLiveVisible(false)
    liveConnectingRef.current = false
    try { pcRef.current?.close() } catch { /* ignore */ }
    pcRef.current = null
    try { webcamStreamRef.current?.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
    webcamStreamRef.current = null
    if (liveVideoRef.current) liveVideoRef.current.srcObject = null
  }, [])

  const attachFrameWatchdog = useCallback((video: HTMLVideoElement) => {
    lastFrameAtRef.current = Date.now()
    const tick = () => {
      lastFrameAtRef.current = Date.now()
      if (video.isConnected) video.requestVideoFrameCallback?.(tick)
    }
    video.requestVideoFrameCallback?.(tick)
  }, [])

  const connectWhep = useCallback(async () => {
    if (liveConnectingRef.current || pcRef.current) return
    liveConnectingRef.current = true
    try {
      const pc = new RTCPeerConnection()
      pcRef.current = pc
      pc.addTransceiver('video', { direction: 'recvonly' })
      pc.addTransceiver('audio', { direction: 'recvonly' })
      pc.ontrack = (e) => {
        const video = liveVideoRef.current
        if (video && e.streams[0]) {
          video.srcObject = e.streams[0]
          void video.play().catch(() => { /* muted autoplay should be allowed */ })
          // Fade in only once real frames decode — never cut to black.
          const onFirstFrame = () => { setLiveVisible(true); attachFrameWatchdog(video) }
          if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFirstFrame)
          else video.addEventListener('loadeddata', onFirstFrame, { once: true })
        }
      }
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
          teardownLive()
        }
      }
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const res = await fetch(settings.whepUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: offer.sdp,
      })
      if (!res.ok) throw new Error(`WHEP ${res.status}`)
      const answer = await res.text()
      await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    } catch {
      teardownLive()
    } finally {
      liveConnectingRef.current = false
    }
  }, [settings.whepUrl, teardownLive, attachFrameWatchdog])

  // Auto-switchover: poll the MediaMTX control API; presence of a
  // publisher is the switch. Only for the WHEP source in auto mode.
  useEffect(() => {
    if (settings.liveSource !== 'whep') return
    if (settings.liveOverride === 'photos') { teardownLive(); return }
    let cancelled = false
    // Back off once the control API is clearly absent. On a projector
    // with no MediaMTX running, a fixed 2 s poll throws a failed fetch
    // into the console ~1,800 times an hour (seen in the live check
    // 2026-09-20) — harmless but alarming to anyone who opens devtools,
    // and pointless load. Recovers to the fast cadence the moment the
    // stream host appears.
    let misses = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const schedule = () => {
      if (cancelled) return
      const delay = misses >= 3 ? LIVE_STATUS_SLOW_MS : LIVE_STATUS_POLL_MS
      timer = setTimeout(tick, delay)
    }

    const tick = async () => {
      if (cancelled) return
      try {
        const res = await fetch(settings.statusUrl, { cache: 'no-store' })
        misses = 0
        const ready = res.ok ? Boolean((await res.json())?.ready) : false
        if (ready || settings.liveOverride === 'live') {
          if (!pcRef.current) void connectWhep()
        } else if (settings.liveOverride === 'auto' && pcRef.current && !ready) {
          teardownLive()
        }
      } catch {
        // Status API unreachable: try the WHEP handshake directly when
        // forced live; in auto mode treat as absent.
        misses += 1
        if (settings.liveOverride === 'live' && !pcRef.current) void connectWhep()
        else if (settings.liveOverride === 'auto' && pcRef.current) {
          // watchdog below decides based on frames
        }
      }
      // Frame watchdog — no frames for LIVE_DEAD_MS → back to photos.
      if (pcRef.current && liveVisible && Date.now() - lastFrameAtRef.current > LIVE_DEAD_MS) {
        teardownLive()
      }
      schedule()
    }

    void tick()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [settings.liveSource, settings.liveOverride, settings.statusUrl, connectWhep, teardownLive, liveVisible])

  const startWebcam = useCallback(async () => {
    teardownLive()
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const cam = devices.find((d) => d.kind === 'videoinput' && /osmo|pocket|dji/i.test(d.label))
      const stream = await navigator.mediaDevices.getUserMedia({
        video: cam ? { deviceId: { exact: cam.deviceId }, width: { ideal: 1920 } } : { width: { ideal: 1920 } },
        audio: false,
      })
      webcamStreamRef.current = stream
      const video = liveVideoRef.current
      if (video) {
        video.srcObject = stream
        void video.play().catch(() => { /* ignore */ })
        setLiveVisible(true)
        attachFrameWatchdog(video)
      }
    } catch {
      teardownLive()
    }
  }, [teardownLive, attachFrameWatchdog])

  useEffect(() => () => teardownLive(), [teardownLive])

  // ── Menu auto-hide + fullscreen ───────────────────────────────────

  const pokeMenu = useCallback(() => {
    setMenuVisible(true)
    if (menuTimerRef.current) clearTimeout(menuTimerRef.current)
    menuTimerRef.current = setTimeout(() => setMenuVisible(false), MENU_HIDE_MS)
  }, [])

  useEffect(() => {
    pokeMenu()
    window.addEventListener('mousemove', pokeMenu)
    return () => {
      window.removeEventListener('mousemove', pokeMenu)
      if (menuTimerRef.current) clearTimeout(menuTimerRef.current)
    }
  }, [pokeMenu])

  // Portal to document.body: fixed positioning inside the event shell
  // gets re-anchored/dimmed by transform/opacity ancestors (same issue
  // the photos tab hit on mobile, 2026-09-19).
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  if (!mounted) return null

  if (!code) {
    return createPortal(
      <div className="fixed inset-0 z-50 bg-black text-white flex items-center justify-center">
        Unknown display link.
      </div>,
      document.body,
    )
  }

  const showLive = liveVisible && settings.liveOverride !== 'photos' && settings.liveSource !== 'youtube'
  const showYoutube = settings.liveSource === 'youtube' && settings.liveOverride === 'live' && settings.youtubeId
  const qrCorner = settings.qrMode !== 'hidden' && qrDataUrl && !(showQrSlide && !showLive)

  // Pure GPU now: no model download, no inference, nothing to fail.
  const cinematicActive = settings.effect === 'cinematic'

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black overflow-hidden flex items-center justify-center"
      style={{ cursor: menuVisible ? 'default' : 'none' }}
    >
      {/* Ambient colour spill — the surround takes the photo's own
          dominant colour, so the room's light shifts with each slide. */}
      <div
        className="absolute inset-0 transition-[background-color] duration-[1600ms] ease-out"
        style={{ backgroundColor: settings.ambient && palette ? palette.ambient : '#000' }}
      />
      {/* 16:9 stage — every visual layer lives inside it. On a 16:9
          projector it fills the screen exactly; on any other display
          it letterboxes rather than reflowing. */}
      <div
        className="relative overflow-hidden"
        style={{
          width: 'min(100vw, calc(100vh * 16 / 9))',
          aspectRatio: '16 / 9',
          backgroundColor: settings.ambient && palette ? palette.ambient : '#000',
          boxShadow: settings.ambient && palette ? `0 0 140px 20px ${palette.accent}22` : undefined,
          transition: 'background-color 1600ms ease-out, box-shadow 1600ms ease-out',
        }}
      >
      {/* Photo layer — never unmounts */}
      {settings.mode === 'slideshow' ? (
        <div className="absolute inset-0">
          {/* Blurred cover fill — replaces dead black letterbox bars,
              and in cinematic mode it is what the melted-away
              background dissolves INTO. */}
          {settings.fillBars && current && (
            // eslint-disable-next-line @next/next/no-img-element -- decorative fill
            <img
              key={`fill-${current.id}`}
              src={current.variants?.medium || current.url}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 w-full h-full object-cover"
              style={{ filter: 'blur(48px) saturate(1.25) brightness(0.55)', transform: 'scale(1.15)' }}
            />
          )}
          {previous && previous.id !== current?.id && (
            // eslint-disable-next-line @next/next/no-img-element -- projector shows originals full-screen
            <img src={previous.url} alt="" className="absolute inset-0 w-full h-full object-contain opacity-0 transition-opacity duration-700" />
          )}
          {current && cinematicActive ? (
            // Deliberately NOT keyed by photo: the renderer keeps one
            // canvas and one WebGL context for the whole display and
            // cross-fades between photos itself. Keying it here threw
            // the canvas away on every slide and left the screen on the
            // blurred fill until the next original had downloaded.
            <div className="absolute inset-0">
              <CinematicPhoto
                src={displaySrc(current)}
                depthSrc={current.variants?.depth ?? null}
                depthStrength={settings.depthStrength ?? 1}
                durationMs={Math.max(settings.intervalMs, 2000)}
                className="absolute inset-0 w-full h-full"
              />
            </div>
          ) : current ? (
            // eslint-disable-next-line @next/next/no-img-element -- projector shows originals full-screen
            <img
              key={current.id}
              src={current.url}
              alt={current.guest_name ? `Photo by ${current.guest_name}` : ''}
              className="absolute inset-0 w-full h-full object-contain"
              style={{ animation: slideAnimation(settings.effect, current.id, settings.intervalMs) }}
            />
          ) : null}
          {current?.guest_name && !showQrSlide && (
            <div className="absolute bottom-6 left-6 flex items-center gap-2 text-white/70 text-xl drop-shadow">
              {/* house line-style (outline) camera icon — no emoji */}
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM18.75 10.5h.008v.008h-.008V10.5z" />
              </svg>
              <span>{current.guest_name}</span>
            </div>
          )}
          {photos.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white/60 gap-6">
              {qrDataUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- data-URL QR
                <img src={qrDataUrl} alt="Upload QR" className="w-64 h-64 rounded-xl bg-white p-3" />
              )}
              <p className="text-2xl">Scan to add the first photo</p>
            </div>
          )}
        </div>
      ) : (
        <div
          className="absolute inset-0 grid gap-1 p-1"
          style={{
            gridTemplateColumns: `repeat(${wallLayoutFor(Math.max(photos.length, 1)).cols}, 1fr)`,
            gridTemplateRows: `repeat(${wallLayoutFor(Math.max(photos.length, 1)).rows}, 1fr)`,
          }}
        >
          {wallCells.map((cell, i) => (
            <div key={i} className="relative overflow-hidden bg-black">
              {cell.previous && cell.previous.id !== cell.current?.id && (
                // eslint-disable-next-line @next/next/no-img-element -- wall cell (outgoing)
                <img
                  src={cell.previous.variants?.medium || cell.previous.url}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                />
              )}
              {cell.current && (
                // eslint-disable-next-line @next/next/no-img-element -- wall cell; object-cover crops to fill
                <img
                  key={cell.current.id}
                  src={cell.current.variants?.medium || cell.current.url}
                  alt={cell.current.guest_name ? `Photo by ${cell.current.guest_name}` : ''}
                  className="absolute inset-0 w-full h-full object-cover"
                  style={{ animation: slideAnimation(settings.effect, cell.current.id, settings.intervalMs) }}
                />
              )}
            </div>
          ))}
          {photos.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white/60 gap-6">
              {qrDataUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- data-URL QR
                <img src={qrDataUrl} alt="Upload QR" className="w-64 h-64 rounded-xl bg-white p-3" />
              )}
              <p className="text-2xl">Scan to add the first photo</p>
            </div>
          )}
        </div>
      )}

      {/* Interleaved full-screen QR card */}
      {showQrSlide && !showLive && qrDataUrl && settings.mode === 'slideshow' && (
        <div className="absolute inset-0 bg-black/95 flex flex-col items-center justify-center gap-6 transition-opacity duration-700">
          {linkInfo?.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- event logo
            <img src={linkInfo.logoUrl} alt="" className="max-h-28 object-contain" />
          )}
          {/* eslint-disable-next-line @next/next/no-img-element -- data-URL QR */}
          <img src={qrDataUrl} alt="Upload QR" className="w-72 h-72 rounded-xl bg-white p-3" />
          <p className="text-white text-3xl font-light">Scan to add your photos</p>
        </div>
      )}

      {/* Live camera layer — fades in above the photos */}
      <div className={`absolute inset-0 bg-black transition-opacity duration-700 ${showLive ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <video ref={liveVideoRef} autoPlay muted playsInline className="w-full h-full object-contain" />
        <div className="absolute top-6 left-6 flex items-center gap-2 text-white/80">
          <span className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
          <span className="text-lg tracking-wide uppercase">Live</span>
        </div>
      </div>
      {showYoutube && (
        <div className="absolute inset-0 bg-black">
          <iframe
            src={`https://www.youtube.com/embed/${encodeURIComponent(settings.youtubeId)}?autoplay=1&mute=1&controls=0`}
            className="w-full h-full"
            allow="autoplay; encrypted-media"
            title="Live stream"
          />
        </div>
      )}
      </div>{/* /16:9 stage */}

      {/* Corner QR + logo card */}
      {qrCorner && (
        <div className="absolute bottom-6 right-6 bg-white/95 rounded-xl p-3 flex flex-col items-center gap-2 shadow-xl">
          {/* eslint-disable-next-line @next/next/no-img-element -- data-URL QR */}
          <img src={qrDataUrl} alt="Upload QR" className="w-32 h-32" />
          {linkInfo?.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- event logo
            <img src={linkInfo.logoUrl} alt="" className="max-h-10 object-contain" />
          )}
          <p className="text-[11px] text-gray-700 font-medium">Scan to add photos</p>
        </div>
      )}

      {/* Settings panel. Sized for a laptop trackpad AND a phone held
          at arm's length next to a projector: one labelled row per
          setting, options on their own line so nothing clips, and the
          whole panel scrolls rather than overflowing the screen. */}
      <div
        className={`absolute top-3 right-3 left-3 sm:left-auto transition-opacity duration-300 ${menuVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      >
        <div data-menu className="ml-auto bg-black/80 backdrop-blur-md rounded-2xl shadow-2xl ring-1 ring-white/10 text-white w-full sm:w-[24rem] max-h-[86vh] overflow-y-auto">
          <div className="p-4 space-y-4">

            <Row label="Display">
              {(['slideshow', 'wall'] as const).map((m) => (
                <Chip key={m} on={settings.mode === m} onClick={() => updateSettings({ mode: m })}>
                  {m === 'slideshow' ? 'Slideshow' : 'Wall'}
                </Chip>
              ))}
              <Chip
                on={false}
                onClick={() => document.documentElement.requestFullscreen?.().catch(() => { /* ignore */ })}
              >
                Fullscreen
              </Chip>
            </Row>

            <Row label="Effect">
              {([
                ['cinematic', 'Cinematic'],
                ['kenburns', 'Ken Burns'],
                ['grade', 'B&W bloom'],
                ['fade', 'Fade'],
                ['slide', 'Slide'],
                ['zoom', 'Zoom'],
                ['blur', 'Blur'],
              ] as const).map(([val, label]) => (
                <Chip key={val} on={settings.effect === val} onClick={() => updateSettings({ effect: val })}>
                  {label}
                </Chip>
              ))}
            </Row>

            {settings.effect === 'cinematic' && (
              <div className="space-y-1.5 -mt-1">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs uppercase tracking-wide text-white/50">3D depth</span>
                  <span className="text-sm tabular-nums text-white/80">
                    {settings.depthStrength === 0 ? 'off' : `${Math.round((settings.depthStrength ?? 1) * 100)}%`}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={200}
                  step={10}
                  value={Math.round((settings.depthStrength ?? 1) * 100)}
                  onChange={(e) => updateSettings({ depthStrength: Number(e.target.value) / 100 })}
                  className="w-full accent-white/80"
                />
                <p className="text-xs text-white/40">
                  Parallax, defocus and haze from each photo&apos;s depth map. Photos without one
                  still get the camera move.
                </p>
              </div>
            )}

            <Row label="Order">
              {([
                ['newest', 'Newest first'],
                ['oldest', 'Oldest first'],
                ['shuffle', 'Shuffle'],
              ] as const).map(([val, label]) => (
                <Chip key={val} on={settings.order === val} onClick={() => updateSettings({ order: val })}>
                  {label}
                </Chip>
              ))}
              <Chip on={settings.instantNew} onClick={() => updateSettings({ instantNew: !settings.instantNew })}>
                Show new instantly
              </Chip>
            </Row>

            <Row label="Look">
              <Chip on={settings.ambient} onClick={() => updateSettings({ ambient: !settings.ambient })}>Ambient colour</Chip>
              <Chip on={settings.fillBars} onClick={() => updateSettings({ fillBars: !settings.fillBars })}>Blurred fill</Chip>
            </Row>

            <Row label="QR code">
              {([
                ['corner', 'Corner'],
                ['interleave', 'Interleave'],
                ['hidden', 'Hidden'],
              ] as const).map(([val, label]) => (
                <Chip key={val} on={settings.qrMode === val} onClick={() => updateSettings({ qrMode: val })}>
                  {label}
                </Chip>
              ))}
            </Row>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <span className="text-xs uppercase tracking-wide text-white/50">Time per photo</span>
                <span className="text-sm tabular-nums text-white/80">{settings.intervalMs / 1000}s</span>
              </div>
              <input
                type="range"
                min={4}
                max={30}
                value={settings.intervalMs / 1000}
                onChange={(e) => updateSettings({ intervalMs: Number(e.target.value) * 1000 })}
                className="w-full accent-white/80"
              />
            </div>

            <hr className="border-white/10" />

            <Row label="Live camera">
              {([
                ['auto', 'Auto'],
                ['live', 'Force live'],
                ['photos', 'Photos only'],
              ] as const).map(([val, label]) => (
                <Chip key={val} on={settings.liveOverride === val} onClick={() => updateSettings({ liveOverride: val })}>
                  {label}
                </Chip>
              ))}
            </Row>

            <Row label="Camera source">
              {([
                ['whep', 'RTMP / MediaMTX'],
                ['webcam', 'USB webcam'],
                ['youtube', 'YouTube'],
              ] as const).map(([val, label]) => (
                <Chip
                  key={val}
                  on={settings.liveSource === val}
                  onClick={() => {
                    teardownLive()
                    updateSettings({ liveSource: val })
                    if (val === 'webcam') void startWebcam()
                  }}
                >
                  {label}
                </Chip>
              ))}
            </Row>

            {settings.liveSource === 'youtube' && (
              <input
                type="text"
                value={settings.youtubeId}
                onChange={(e) => updateSettings({ youtubeId: e.target.value.trim().slice(0, 20) })}
                placeholder="YouTube video id"
                className="w-full rounded-lg bg-white/10 px-3 py-2 text-sm placeholder:text-white/40"
              />
            )}

          </div>
        </div>
      </div>

      {/* plain <style>, not styled-jsx — module pages must not depend on
          compiler transforms beyond what every sibling page uses */}
      <style>{EFFECT_KEYFRAMES}</style>
    </div>,
    document.body,
  )
}
