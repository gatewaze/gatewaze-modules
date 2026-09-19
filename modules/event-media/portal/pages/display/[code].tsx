'use client'

// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * Projector display page — full-bleed live gallery/slideshow of an
 * event's guest photos, with an optional live-camera layer on top.
 *
 *   /event-media/display/<code>
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

import { useState, useEffect, useCallback, useRef } from 'react'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''
const POLL_MS = 10_000
const MAX_PHOTOS = 500
const MENU_HIDE_MS = 4_000
const LIVE_STATUS_POLL_MS = 2_000
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

interface DisplaySettings {
  mode: 'slideshow' | 'wall'
  intervalMs: number
  qrMode: 'corner' | 'interleave' | 'hidden'
  qrEveryN: number
  liveSource: 'whep' | 'webcam' | 'youtube'
  liveOverride: 'auto' | 'live' | 'photos'
  whepUrl: string
  statusUrl: string
  youtubeId: string
}

const DEFAULT_SETTINGS: DisplaySettings = {
  mode: 'slideshow',
  intervalMs: 8000,
  qrMode: 'interleave',
  qrEveryN: 10,
  liveSource: 'whep',
  liveOverride: 'auto',
  whepUrl: DEFAULT_WHEP_URL,
  statusUrl: DEFAULT_STATUS_URL,
  youtubeId: '',
}

interface DisplayPageProps {
  // Module portal pages are mounted via /m/[...path]; the platform
  // extracts route-pattern params and passes them as a prop —
  // next/navigation's useParams() would only see the catch-all here.
  params?: { code?: string }
}

export default function DisplayPage({ params }: DisplayPageProps) {
  const rawCode = params?.code
  const code = typeof rawCode === 'string' && /^[a-z0-9]{6,16}$/.test(rawCode) ? rawCode : null

  const settingsKey = `event_media_display:${code ?? ''}`
  const [settings, setSettings] = useState<DisplaySettings>(DEFAULT_SETTINGS)
  const [linkInfo, setLinkInfo] = useState<{ eventId: string | null; logoUrl: string | null; identifier: string | null } | null>(null)
  const [photos, setPhotos] = useState<DisplayItem[]>([])
  const photosRef = useRef<DisplayItem[]>([])
  const freshQueueRef = useRef<DisplayItem[]>([])
  const newestRef = useRef<string | null>(null)

  const [current, setCurrent] = useState<DisplayItem | null>(null)
  const [previous, setPrevious] = useState<DisplayItem | null>(null)
  const [showQrSlide, setShowQrSlide] = useState(false)
  const advanceCountRef = useRef(0)
  const indexRef = useRef(0)

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
      if (fresh) freshQueueRef.current.push(...add)
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
      if (fresh) {
        indexRef.current = 0
        return fresh
      }
      const list = photosRef.current
      if (list.length === 0) return prev
      indexRef.current = (indexRef.current + 1) % list.length
      return list[indexRef.current]
    })
  }, [settings.qrMode, settings.qrEveryN])

  useEffect(() => {
    if (settings.mode !== 'slideshow') return
    if (!current && photosRef.current.length > 0) setCurrent(photosRef.current[0])
    const interval = setInterval(advance, Math.max(settings.intervalMs, 2000))
    return () => clearInterval(interval)
  }, [settings.mode, settings.intervalMs, advance, current, photos.length])

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
    const interval = setInterval(async () => {
      if (cancelled) return
      try {
        const res = await fetch(settings.statusUrl, { cache: 'no-store' })
        const ready = res.ok ? Boolean((await res.json())?.ready) : false
        if (ready || settings.liveOverride === 'live') {
          if (!pcRef.current) void connectWhep()
        } else if (settings.liveOverride === 'auto' && pcRef.current && !ready) {
          teardownLive()
        }
      } catch {
        // Status API unreachable: try the WHEP handshake directly when
        // forced live; in auto mode treat as absent.
        if (settings.liveOverride === 'live' && !pcRef.current) void connectWhep()
        else if (settings.liveOverride === 'auto' && pcRef.current) {
          // watchdog below decides based on frames
        }
      }
      // Frame watchdog — no frames for LIVE_DEAD_MS → back to photos.
      if (pcRef.current && liveVisible && Date.now() - lastFrameAtRef.current > LIVE_DEAD_MS) {
        teardownLive()
      }
    }, LIVE_STATUS_POLL_MS)
    return () => { cancelled = true; clearInterval(interval) }
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

  if (!code) {
    return (
      <div className="fixed inset-0 z-50 bg-black text-white flex items-center justify-center">
        Unknown display link.
      </div>
    )
  }

  const showLive = liveVisible && settings.liveOverride !== 'photos' && settings.liveSource !== 'youtube'
  const showYoutube = settings.liveSource === 'youtube' && settings.liveOverride === 'live' && settings.youtubeId
  const qrCorner = settings.qrMode !== 'hidden' && qrDataUrl && !(showQrSlide && !showLive)

  return (
    <div className="fixed inset-0 z-50 bg-black overflow-hidden" style={{ cursor: menuVisible ? 'default' : 'none' }}>
      {/* Photo layer — never unmounts */}
      {settings.mode === 'slideshow' ? (
        <div className="absolute inset-0">
          {previous && previous.id !== current?.id && (
            // eslint-disable-next-line @next/next/no-img-element -- projector shows originals full-screen
            <img src={previous.url} alt="" className="absolute inset-0 w-full h-full object-contain opacity-0 transition-opacity duration-700" />
          )}
          {current && (
            // eslint-disable-next-line @next/next/no-img-element -- projector shows originals full-screen
            <img
              key={current.id}
              src={current.url}
              alt={current.guest_name ? `Photo by ${current.guest_name}` : ''}
              className="absolute inset-0 w-full h-full object-contain animate-[fadein_700ms_ease]"
            />
          )}
          {current?.guest_name && !showQrSlide && (
            <div className="absolute bottom-6 left-6 text-white/70 text-xl drop-shadow">📷 {current.guest_name}</div>
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
        <div className="absolute inset-0 overflow-y-auto p-2">
          <div className="columns-4 xl:columns-5 gap-2">
            {photos.map((p) => (
              // eslint-disable-next-line @next/next/no-img-element -- wall grid
              <img key={p.id} src={p.variants?.medium || p.url} alt="" className="w-full mb-2 rounded-lg break-inside-avoid" loading="lazy" />
            ))}
          </div>
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

      {/* Corner menu */}
      <div className={`absolute top-4 right-4 transition-opacity duration-300 ${menuVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <div className="bg-black/70 backdrop-blur rounded-xl p-3 text-white text-sm space-y-2 w-64">
          <div className="flex gap-1">
            {(['slideshow', 'wall'] as const).map((m) => (
              <button
                key={m}
                onClick={() => updateSettings({ mode: m })}
                className={`flex-1 rounded px-2 py-1 capitalize ${settings.mode === m ? 'bg-white/25' : 'bg-white/5'}`}
              >
                {m}
              </button>
            ))}
            <button
              onClick={() => document.documentElement.requestFullscreen?.().catch(() => { /* ignore */ })}
              className="rounded px-2 py-1 bg-white/5"
              title="Fullscreen"
            >
              ⛶
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16 text-white/60">QR</span>
            {(['corner', 'interleave', 'hidden'] as const).map((m) => (
              <button
                key={m}
                onClick={() => updateSettings({ qrMode: m })}
                className={`rounded px-2 py-0.5 text-xs capitalize ${settings.qrMode === m ? 'bg-white/25' : 'bg-white/5'}`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16 text-white/60">Every</span>
            <input
              type="range" min={4} max={30} value={settings.intervalMs / 1000}
              onChange={(e) => updateSettings({ intervalMs: Number(e.target.value) * 1000 })}
              className="flex-1"
            />
            <span className="text-xs w-8">{settings.intervalMs / 1000}s</span>
          </div>
          <hr className="border-white/20" />
          <div className="flex items-center gap-2">
            <span className="w-16 text-white/60">Camera</span>
            {(['auto', 'live', 'photos'] as const).map((m) => (
              <button
                key={m}
                onClick={() => updateSettings({ liveOverride: m })}
                className={`rounded px-2 py-0.5 text-xs capitalize ${settings.liveOverride === m ? 'bg-white/25' : 'bg-white/5'}`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16 text-white/60">Source</span>
            {(['whep', 'webcam', 'youtube'] as const).map((s) => (
              <button
                key={s}
                onClick={() => {
                  teardownLive()
                  updateSettings({ liveSource: s })
                  if (s === 'webcam') void startWebcam()
                }}
                className={`rounded px-2 py-0.5 text-xs uppercase ${settings.liveSource === s ? 'bg-white/25' : 'bg-white/5'}`}
              >
                {s === 'whep' ? 'RTMP' : s}
              </button>
            ))}
          </div>
          {settings.liveSource === 'youtube' && (
            <input
              type="text"
              value={settings.youtubeId}
              onChange={(e) => updateSettings({ youtubeId: e.target.value.trim().slice(0, 20) })}
              placeholder="YouTube video id"
              className="w-full rounded bg-white/10 px-2 py-1 text-xs"
            />
          )}
        </div>
      </div>

      {/* plain <style>, not styled-jsx — module pages must not depend on
          compiler transforms beyond what every sibling page uses */}
      <style>{'@keyframes fadein { from { opacity: 0 } to { opacity: 1 } }'}</style>
    </div>
  )
}
