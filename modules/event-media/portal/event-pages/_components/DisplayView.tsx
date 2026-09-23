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
import WedflixCard, { type CardCopy } from './WedflixCard'
import { extractPalette, type PhotoPalette } from './_lib/photo-fx'
import {
  DEFAULT_BOOTH,
  DEFAULT_PRELOAD,
  DEFAULT_DAY,
  DEFAULT_ROTATION,
  VIEW_LABEL,
  VIEW_ORDER,
  dayAlbums,
  migrateStreams,
  nextInRotation,
  normaliseRotation,
  normaliseStream,
  type StreamSettings,
  type ViewName,
} from './_lib/display-settings'
import { feedChanged, hasBrowseCard, isReady, pollAfter, pruneMissing } from './_lib/photo-ready'
import { sizedDisplayUrl } from './_lib/display-url'

// Same-origin — proxied to the api service by the portal's
// /api/public/* rewrite (see photos.tsx note).
const API_BASE = ''
// A guest who has just pressed "Put it on the big screen" is watching.
const POLL_MS = 5_000
const VERSION_CHECK_MS = 2 * 60_000
const RELOAD_DELAY_MS = 4 * 60_000
/** How often the whole feed is re-read to notice deletions. */
const SWEEP_MS = 30_000
const MAX_PHOTOS = 500
/**
 * An open settings panel closes itself after this long untouched, so it
 * can never be forgotten over the projection for the rest of the night.
 */
const MENU_IDLE_MS = 60_000
/** How long the "press Esc" hint shows when the display first loads. */
const HINT_MS = 5_000
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
  /** Browse-card copy, generated per photo. Absent until it lands. */
  card?: CardCopy | null
  /** 'booth' | 'day' | 'ready' | 'seed'. Older rows read as 'seed'. */
  album?: string
  created_at: string
}

type SlideEffect = 'wedflix' | 'cinematic' | 'kenburns' | 'grade' | 'fade' | 'slide' | 'zoom' | 'blur'

interface DisplaySettings {
  /** @deprecated per-stream now; kept so stored settings still migrate. */
  mode: 'slideshow' | 'wall'
  /** @deprecated per-stream now. */
  intervalMs: number
  /** @deprecated per-stream now. */
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
  /**
   * Which stream the screen is on. 'mix' rotates through `rotation`, so
   * one projector can carry several albums in turn.
   */
  stream: ViewName | 'mix'
  /** How long 'mix' dwells on each stream. */
  mixSeconds: number
  /** The views 'mix' rotates through, in panel order. */
  rotation: ViewName[]
  /** Per-stream treatment. */
  preload: StreamSettings
  day: StreamSettings
  booth: StreamSettings
  /** How pronounced the 3D relief is. 0 is a flat camera move. */
  depthStrength: number
  /** @deprecated per-stream now. */
  camera: 'pan' | 'panzoom'
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
  // Preload is the only view with photos before the day's uploads exist.
  stream: 'preload',
  mixSeconds: 90,
  rotation: [...DEFAULT_ROTATION],
  preload: DEFAULT_PRELOAD,
  day: DEFAULT_DAY,
  booth: DEFAULT_BOOTH,
  depthStrength: 1,
  camera: 'pan',
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

/** Roughly one card in three shows a chart position. */
function rankFor(id: string): boolean {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return Math.abs(h) % 3 === 0
}

/**
 * Split the incoming media into the view being shown.
 *
 *   preload  the selfies, all of them
 *   day      the day's uploads
 *   booth    the booth's posters
 *
 * The day used to be padded with selfies up to twenty photos. That made
 * the slideshow feel short -- the same eighteen or so selfies every
 * rotation, with a hundred more never shown -- and mixed two things that
 * are better chosen deliberately. Preload is now its own view.
 *
 * `wedflixOnly` narrows the day and the booth to photos that will be
 * billed as a programme: a slide with no browse card, in a mode whose
 * whole point is the browse card, just looks like the effect failed.
 * It does not apply to Preload, whose selfies are never billed.
 */
function poolFor(all: DisplayItem[], mode: ViewName, wedflixOnly = false, needsLayers = true): DisplayItem[] {
  // Under the cinematic effects a photo joins the projector only once its
  // layers and browse copy exist: shown earlier it pans across with no
  // depth and no title and then silently acquires both, which reads as a
  // fault. The other effects use neither, and waiting for them only kept
  // a just-posted booth picture off the wall for half a minute
  // (2026-09-22). The guest's own gallery is never gated.
  const shown = needsLayers ? all.filter((p) => isReady(p)) : all
  if (mode === 'preload') {
    // Anything not explicitly another view's. Older rows carry no album
    // at all, and those are the selfies.
    return shown.filter((p) => p.album !== 'day' && p.album !== 'booth' && p.album !== 'ready')
  }
  // The day also carries Getting ready until it has enough of its own
  // (dayAlbums, display-settings.ts). Counted over everything loaded, not
  // just what is ready to show, so the switch does not flicker.
  const albums = mode === 'day' ? dayAlbums(all) : new Set([mode])
  const inView = shown.filter((p) => albums.has(p.album ?? ''))
  return wedflixOnly ? inView.filter((p) => hasBrowseCard(p)) : inView
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
@keyframes emfadeout { from { opacity: 1 } to { opacity: 0 } }
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
/**
 * `columns` forces a single row of that width, which is what portrait
 * booth posters want: three 3:4 posters side by side very nearly fill a
 * 16:9 stage, where a best-fit grid would stack them into letterboxes.
 * 0 keeps the automatic grid.
 */
function wallLayoutFor(count: number, columns = 0) {
  if (columns > 0) return { cells: Math.min(columns, Math.max(count, 1)), cols: columns, rows: 1 }
  return WALL_LAYOUTS.find((l) => l.cells <= count) ?? WALL_LAYOUTS[WALL_LAYOUTS.length - 1]!
}

/** One labelled settings row. The label sits above its options so a
 *  long option list wraps cleanly instead of clipping off the panel. */
/**
 * One photo in a wall cell.
 *
 * The cells sit edge to edge with no border, so a photo that does not
 * fill its cell would otherwise show black bands above and below -- the
 * photos are all shapes. Behind each one goes a blurred, darkened copy of
 * itself, scaled past the edges so the blur has nothing to smear in from,
 * which fills the cell with that photo's own colours (asked 2026-09-22).
 * A wall that crops its photos to fill needs no such backing.
 */
function WallPicture({ item, fit, style }: {
  item: DisplayItem
  fit: string
  style?: React.CSSProperties
}) {
  const src = item.variants?.medium || item.url
  return (
    <div className="absolute inset-0" style={style}>
      {fit === 'object-contain' && (
        // eslint-disable-next-line @next/next/no-img-element -- ambient fill
        <img
          src={src}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover"
          style={{ transform: 'scale(1.2)', filter: 'blur(34px) saturate(1.4) brightness(.5)' }}
        />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- wall cell */}
      <img
        src={src}
        alt={item.guest_name ? `Photo by ${item.guest_name}` : ''}
        className={`absolute inset-0 w-full h-full ${fit}`}
      />
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs uppercase tracking-wide text-white/50">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

/**
 * A choice within a row. Selected is filled and ticked, unselected is a
 * dim outline — the two used to differ only by how light their grey
 * was, which is unreadable across a room at a projector.
 *
 * Colours are inline rather than Tailwind classes. `text-gray-900` never
 * reached the module page's stylesheet, so a selected chip inherited the
 * panel's white and rendered as a blank white box: the label was there
 * and invisible. Sized for a finger as well as a trackpad.
 */
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className="rounded-lg px-3 py-1.5 text-sm leading-none border transition-colors"
      style={on
        ? { background: '#fff', color: '#111827', fontWeight: 600, borderColor: '#fff' }
        : { background: 'transparent', color: 'rgba(255,255,255,.55)', borderColor: 'rgba(255,255,255,.25)' }}
    >
      {on && <span aria-hidden="true" style={{ marginRight: '.4em' }}>✓</span>}
      {children}
    </button>
  )
}

/**
 * An on/off setting. Unlike a Chip these are not a set of alternatives,
 * so "which one is lit" tells you nothing — each states its own value.
 */
function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      role="switch"
      aria-checked={on}
      className="rounded-lg px-3 py-1.5 text-sm leading-none border transition-colors inline-flex items-center gap-2"
      style={on
        ? { background: '#34d399', color: '#052e16', fontWeight: 600, borderColor: '#6ee7b7' }
        : { background: 'transparent', color: 'rgba(255,255,255,.55)', borderColor: 'rgba(255,255,255,.25)' }}
    >
      <span>{children}</span>
      <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.08em', opacity: .75 }}>
        {on ? 'on' : 'off'}
      </span>
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
  // The pose everyone is being asked for, so the room can see it without
  // opening a phone (asked 2026-09-22). Re-read as the slots turn over.
  const [posesInfo, setPosesInfo] = useState<{
    mode: string
    current: { label: string; instruction: string } | null
    next: { label: string } | null
    changes_at: string | null
  } | null>(null)
  const [poseNow, setPoseNow] = useState(() => Date.now())
  const [photos, setPhotos] = useState<DisplayItem[]>([])
  // Mirrored so the upload handler can pool without depending on
  // settings, which would re-create it on every unrelated change.
  const streamRef = useRef<ViewName>('preload')
  // Mirrored for the same reason: new arrivals must be pooled by the
  // Wedflix rule too, or an uncarded upload would slip straight in.
  const wedflixRef = useRef(false)
  const layersRef = useRef(true)

  /**
   * Which stream is on screen now. In 'mix' this rotates on its own
   * clock through the chosen views, so one projector carries them all.
   *
   * Every hook below names `activeStream` or `view`, and a dependency
   * array is evaluated during render, so both are declared here above
   * the `if (!mounted) return null` guard further down. A hook after an
   * early return runs on some renders and not others, which is React
   * error #310 and takes the whole display out.
   */
  const rotation: ViewName[] = settings.rotation ?? [...DEFAULT_ROTATION]
  const [mixPhase, setMixPhase] = useState<ViewName>(rotation[0] ?? 'day')
  const activeStream: ViewName = settings.stream === 'mix'
    ? (rotation.includes(mixPhase) ? mixPhase : rotation[0] ?? 'day')
    : settings.stream
  const view: StreamSettings = settings[activeStream] ?? DEFAULT_SETTINGS[activeStream]
  const wedflixOnly = view.effect === 'wedflix'
  const needsLayers = view.effect === 'wedflix' || view.effect === 'cinematic'

  // Read by the rotation clock, so it can skip an album with nothing to
  // show without restarting every time a photo lands or a setting moves.
  const allPhotosRef = useRef<DisplayItem[]>([])
  const settingsRef = useRef<DisplaySettings>(settings)
  useEffect(() => { allPhotosRef.current = photos }, [photos])
  useEffect(() => { settingsRef.current = settings }, [settings])

  const rotationKey = rotation.join(',')
  useEffect(() => {
    if (settings.stream !== 'mix') return
    const every = Math.max(15, settings.mixSeconds ?? 90) * 1000
    const t = setInterval(() => {
      const st = settingsRef.current
      const order = st.rotation ?? [...DEFAULT_ROTATION]
      setMixPhase((p) => nextInRotation(order, p, (v) => {
        const vs = st[v] ?? DEFAULT_SETTINGS[v]
        return poolFor(allPhotosRef.current, v, vs.effect === 'wedflix', vs.effect === 'wedflix' || vs.effect === 'cinematic').length > 0
      }))
    }, every)
    return () => clearInterval(t)
  }, [settings.stream, settings.mixSeconds, rotationKey])

  // What the projector is actually showing, so counts and layout agree
  // with what advance() walks.
  const pool = poolFor(photos, activeStream, wedflixOnly, needsLayers)

  useEffect(() => {
    streamRef.current = activeStream
    wedflixRef.current = wedflixOnly
    layersRef.current = needsLayers
    // Switching stream re-pools from everything already loaded, and
    // cuts straight to the new stream. Without the cut, a swap in 'mix'
    // would leave the previous stream on screen for up to a full slide
    // — long enough to look broken on a 90 second rotation.
    setPhotos((all) => {
      const next = poolFor(all, activeStream, wedflixOnly, needsLayers)
      photosRef.current = next
      indexRef.current = 0
      if (next.length) setCurrent(orderedPool(next, settings.order)[0] ?? null)
      return all
    })
    setSlideTick((t) => t + 1)
    // `order` is read, not watched: a change of order should not force
    // a cut, it only decides which photo this one lands on. Turning
    // Wedflix on or off changes which photos qualify, so it re-pools and
    // cuts just as a change of view does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStream, wedflixOnly, needsLayers])
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

  // Starts hidden: it opens from the keyboard now, not the mouse.
  const [menuVisible, setMenuVisible] = useState(false)
  const [showHint, setShowHint] = useState(true)
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
      if (!raw) return
      // The stored object, NOT the stored object merged over the
      // defaults: migrateStreams has to be able to see what was
      // actually saved (see display-settings.ts).
      const stored = JSON.parse(raw) as Record<string, unknown>
      setSettings({
        ...DEFAULT_SETTINGS,
        ...stored,
        stream: normaliseStream(stored['stream']),
        rotation: normaliseRotation(stored['rotation']),
        ...migrateStreams(stored),
      })
    } catch { /* defaults are fine */ }
  }, [settingsKey])

  /**
   * Which stream the panel is editing. In 'mix' that cannot be inferred
   * from what is on screen, because what is on screen keeps changing.
   * Not persisted: it is a view of the panel, not a setting.
   */
  const [editing, setEditing] = useState<ViewName>('preload')
  const editTarget: ViewName = editing
  const edited: StreamSettings = settings[editTarget] ?? DEFAULT_SETTINGS[editTarget]

  const updateSettings = useCallback((patch: Partial<DisplaySettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      try { localStorage.setItem(settingsKey, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [settingsKey])

  /** Patch the stream the panel is currently editing. */
  const updateStream = useCallback((patch: Partial<StreamSettings>) => {
    setSettings((prev) => {
      const key: ViewName = editing
      const next = { ...prev, [key]: { ...(prev[key] ?? DEFAULT_SETTINGS[key]), ...patch } }
      try { localStorage.setItem(settingsKey, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [settingsKey, editing])

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
        setPosesInfo(data.booth?.poses ?? null)
      })
      .catch(() => { /* poll retries below */ })
  }, [code])

  useEffect(() => {
    if (posesInfo?.mode !== 'hour') return
    const t = setInterval(() => setPoseNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [posesInfo?.mode])

  useEffect(() => {
    if (posesInfo?.mode !== 'hour' || !posesInfo.changes_at || !code) return
    const due = new Date(posesInfo.changes_at).getTime() - Date.now()
    const t = setTimeout(() => {
      fetch(`${API_BASE}/api/public/event-media/links/${code}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => { if (data?.booth?.poses) setPosesInfo(data.booth.poses) })
        .catch(() => { /* the next slot tries again */ })
    }, Math.max(1000, due + 1500))
    return () => clearTimeout(t)
  }, [posesInfo, code])

  // A projector is opened once and left running for hours. When a new
  // version is deployed it reloads itself -- after a pause, because the
  // API reports the new version a minute or two before the portal is
  // serving the new page. Found 2026-09-22: a projector still running the
  // code from before a fix was mistaken for the fix not working.
  useEffect(() => {
    if (!code) return
    let first: string | null = null
    let reloadAt: ReturnType<typeof setTimeout> | null = null
    const check = () => {
      fetch(`${API_BASE}/api/public/event-media/links/${code}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          const v = typeof data?.version === 'string' ? data.version : null
          if (!v) return
          if (first === null) { first = v; return }
          if (v !== first && !reloadAt) reloadAt = setTimeout(() => window.location.reload(), RELOAD_DELAY_MS)
        })
        .catch(() => { /* try again next time */ })
    }
    check()
    const iv = setInterval(check, VERSION_CHECK_MS)
    return () => { clearInterval(iv); if (reloadAt) clearTimeout(reloadAt) }
  }, [code])

  const ingest = useCallback((incoming: DisplayItem[], fresh: boolean) => {
    // Defensive: never let a non-photo reach the projector even if the
    // API were to return one. Booth posters are a separate stream and
    // are filtered by the pool builder below, not here, so they still
    // arrive and can be shown in booth mode.
    const clean = incoming.filter((i) => i.kind === 'photo')
    if (clean.length === 0) return
    setPhotos((prev) => {
      const seen = new Set(prev.map((p) => p.id))
      const add = clean.filter((i) => !seen.has(i.id))
      // A photo already held can come back finished -- layers, browse
      // card, or moved to another album. Take the newer copy; ignoring it
      // is what left new booth posters off the screen until a refresh.
      const byId = new Map(clean.map((i) => [i.id, i]))
      let changed = false
      const held = prev.map((p) => {
        const next = byId.get(p.id)
        if (!next || !feedChanged(p, next)) return p
        changed = true
        return { ...p, ...next }
      })
      if (add.length === 0 && !changed) return prev
      // A queued arrival that has just finished gets its instant cut now.
      if (changed && freshQueueRef.current.some((f) => byId.has(f.id))) {
        setFreshArrivals((n) => n + 1)
      }
      if (fresh && add.length > 0) {
        freshQueueRef.current.push(...add)
        // Signal the instant-cut effect (setState during another
        // component's updater is fine here — different state atom,
        // and React batches it into the same commit).
        setFreshArrivals((n) => n + 1)
      }
      const merged = [...add, ...held].slice(0, MAX_PHOTOS)
      // The projector draws from the pooled stream, not everything that
      // has ever been uploaded.
      photosRef.current = poolFor(merged, streamRef.current, wedflixRef.current, layersRef.current)
      const newest = merged[0]?.created_at
      if (newest && (!newestRef.current || newest > newestRef.current)) newestRef.current = newest
      return merged
    })
  }, [])

  /**
   * Let go of photos the feed no longer lists (a guest deleted their
   * booth picture, or an organiser hid one). A deleted photo that is on
   * screen right now is cut away from at once.
   */
  const prune = useCallback((listed: DisplayItem[], complete: boolean) => {
    setPhotos((prev) => {
      const next = pruneMissing(prev, listed, complete)
      if (next.length === prev.length) return prev
      const keep = new Set(next.map((p) => p.id))
      photosRef.current = poolFor(next, streamRef.current, wedflixRef.current, layersRef.current)
      freshQueueRef.current = freshQueueRef.current.filter((f) => keep.has(f.id))
      setCurrent((c) => (c && !keep.has(c.id) ? photosRef.current[0] ?? null : c))
      return next
    })
  }, [])

  useEffect(() => {
    if (!code) return
    let cancelled = false
    // Every 30 s, the whole first page: picks up deletions and hides,
    // which the incremental poll (new rows only) cannot see.
    const sweep = async () => {
      try {
        const qs = new URLSearchParams({ filter: 'photo', limit: '200' })
        const res = await fetch(`${API_BASE}/api/public/event-media/links/${code}/media?${qs}`)
        if (!res.ok || cancelled) return
        const data = await res.json()
        const listed = ((data.items ?? []) as DisplayItem[]).filter((i) => i.kind === 'photo')
        prune(listed, !data.next_cursor)
        ingest(listed, false)
      } catch { /* the next sweep tries again */ }
    }
    const sweeper = setInterval(sweep, SWEEP_MS)
    const load = async (incremental: boolean) => {
      try {
        const qs = new URLSearchParams({ filter: 'photo', limit: '200' })
        // From the oldest photo still processing, not just the newest, so
        // a photo seen half-made is fetched again once it is finished.
        const since = incremental ? pollAfter(allPhotosRef.current, newestRef.current) : null
        if (since) qs.set('after', since)
        const res = await fetch(`${API_BASE}/api/public/event-media/links/${code}/media?${qs}`)
        if (!res.ok || cancelled) return
        const data = await res.json()
        ingest(data.items ?? [], incremental)
      } catch { /* silent — never an error toast mid-reception */ }
    }
    load(false)
    const interval = setInterval(() => load(true), POLL_MS)
    return () => { cancelled = true; clearInterval(interval); clearInterval(sweeper) }
  }, [code, ingest, prune])

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

  /**
   * The next fresh arrival that is actually finished.
   *
   * Arrivals are queued the moment their bytes land, which is before
   * their layers and browse copy exist. The queued object is a snapshot
   * from that moment, so readiness is judged against the CURRENT pool
   * instead: photosRef holds the ready-filtered list, so presence there
   * is the answer. Anything not ready stays queued for a later cut
   * rather than being dropped.
   */
  const takeReadyFresh = useCallback((): DisplayItem | null => {
    const q = freshQueueRef.current
    const pool = photosRef.current
    for (let i = 0; i < q.length; i++) {
      const live = pool.find((p) => p.id === q[i]!.id)
      if (live) {
        q.splice(i, 1)
        return live
      }
    }
    return null
  }, [])

  const advance = useCallback(() => {
    const fresh = takeReadyFresh()
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
  }, [settings.qrMode, settings.qrEveryN, settings.order, takeReadyFresh])

  useEffect(() => {
    if (view.mode !== 'slideshow') return
    if (!current && photosRef.current.length > 0) setCurrent(photosRef.current[0])
    const interval = setInterval(advance, Math.max(view.intervalMs, 2000))
    return () => clearInterval(interval)
    // slideTick restarts the timer after an interrupt so a photo cut to
    // early still gets its full time on screen.
  }, [view.mode, view.intervalMs, advance, current, pool.length, slideTick])

  // Cut to new arrivals immediately. The poll finds them within ~10 s;
  // without this they would then wait out the rest of the current
  // slide too, so a guest could stand there for 18 s. One interrupt
  // per burst — the rest of the batch drains through the normal
  // fresh-queue priority rather than strobing past.
  useEffect(() => {
    if (!settings.instantNew || view.mode !== 'slideshow') return
    if (freshArrivals === 0) return
    advance()
    setSlideTick((t) => t + 1)
  }, [freshArrivals, settings.instantNew, view.mode, advance])

  // ── Wall mode: staggered per-cell slides ──────────────────────────

  useEffect(() => {
    if (view.mode !== 'wall') return
    const interval = Math.max(view.intervalMs, 2000)

    const pickNext = (displayed: Set<string>): DisplayItem | null => {
      const list = orderedPool(photosRef.current, settings.order)
      if (list.length === 0) return null
      // Fresh uploads jump straight onto the wall, once finished.
      const fresh = takeReadyFresh()
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
        const layout = wallLayoutFor(count, view.columns)
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
        const wantsInstant = settings.instantNew
          && freshQueueRef.current.some((f) => photosRef.current.some((p) => p.id === f.id))
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
  }, [view.mode, view.intervalMs, settings.order, settings.instantNew, takeReadyFresh])

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
    const dpr = Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 2)
    const w = Math.min(3840, Math.max(1280, Math.round((window.innerWidth || 1920) * dpr)))
    const h = Math.round((w * 9) / 16)
    // Supabase and a CDN resize differently; see display-url.ts for why
    // getting this wrong costs money without looking wrong.
    // Prefer the upscaled copy where one exists. Upscaling only helps if
    // the projector actually fetches it; reading item.url here would
    // keep showing the small original the upscale was paid to replace.
    return sizedDisplayUrl(item.variants?.hires || item.url, w, h)
  }, [])

  // Fetch the NEXT slide's image during the current one, so the
  // cross-fade always has it decoded and ready.
  useEffect(() => {
    if (view.effect !== 'cinematic' || !current) return
    const list = photosRef.current
    const upcoming = freshQueueRef.current.find((f) => list.some((p) => p.id === f.id))
      ?? list[(indexRef.current + 1) % Math.max(list.length, 1)]
    if (!upcoming || upcoming.id === current.id) return
    // Warm the LAYERS too. Warming only the photo left the renderer
    // waiting on a plate and cutout fetch at the moment of the cut,
    // which is why the outgoing photo sat on screen after the new one
    // had been chosen.
    for (const href of [
      displaySrc(upcoming),
      upcoming.variants?.plate,
      upcoming.variants?.cutout,
      upcoming.variants?.depth,
    ]) {
      if (!href) continue
      const warm = new window.Image()
      warm.crossOrigin = 'anonymous'
      warm.src = href
    }
  }, [current, view.effect, displaySrc])

  /*
   * Preload the next slide for the CSS effects.
   *
   * This used to fetch next.url — the untouched full-size original,
   * which nothing on screen ever displays, so it warmed the wrong file
   * and paid for a full download every slide. It now fetches the URL the
   * slide will actually use.
   *
   * It lives down here, below displaySrc, on purpose. A dependency array
   * is evaluated during render, so naming displaySrc from above its
   * declaration throws before anything paints and takes the display out.
   *
   * The cinematic effects are skipped: the warmer above already fetches
   * that photo along with its depth layers.
   */
  useEffect(() => {
    if (view.effect === 'cinematic' || view.effect === 'wedflix') return
    const list = photosRef.current
    if (list.length < 2) return
    const next = freshQueueRef.current.find((f) => list.some((p) => p.id === f.id))
      ?? list[(indexRef.current + 1) % list.length]
    if (next) {
      const img = new window.Image()
      img.src = displaySrc(next)
    }
  }, [current, view.effect, displaySrc])

  // ── QR overlay ────────────────────────────────────────────────────

  // The QR goes where the screen is pointing people: the booth's own
  // page while the booth's posters are up, the wedding-photos page for
  // every other view. Built from this page's own address, so it works on
  // the event's own domain and on the portal alike.
  const qrTab: 'booth' | 'photos' = activeStream === 'booth' ? 'booth' : 'photos'
  useEffect(() => {
    if (!code || settings.qrMode === 'hidden') { setQrDataUrl(null); return }
    const target = `${window.location.origin}${window.location.pathname}?u=${code}${qrTab === 'booth' ? '&tab=booth' : ''}`
    let cancelled = false
    import('qrcode')
      .then((QRCode) => QRCode.toDataURL(target, { width: 512, margin: 1 }))
      .then((url) => { if (!cancelled) setQrDataUrl(url) })
      .catch(() => { if (!cancelled) setQrDataUrl(null) }) // dep unavailable → no QR, page still works
    return () => { cancelled = true }
  }, [code, settings.qrMode, qrTab])

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

  /*
   * The panel opens from the keyboard, not the mouse.
   *
   * It used to appear on any mouse movement, so on the projector laptop
   * someone brushing the trackpad put the settings over the photos in
   * front of the whole room. Escape now toggles it, and M does too.
   *
   * Why M as well: Escape is also the key that leaves fullscreen, and a
   * projector runs fullscreen. The lock below keeps a short Escape press
   * for the page where the browser supports it; where it does not, M
   * opens the panel without ever touching fullscreen.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      // Escape always works, including to close the panel from a field.
      // M must not fire while someone is typing a URL or a YouTube id.
      const toggle = e.key === 'Escape' || (!typing && (e.key === 'm' || e.key === 'M'))
      if (!toggle) return
      e.preventDefault()
      setShowHint(false)
      setMenuVisible((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /*
   * Keep a short Escape press for the page while fullscreen.
   *
   * Without this the browser takes Escape to leave fullscreen, and the
   * projector drops out of it the moment anyone opens the settings. The
   * Keyboard Lock API exists for exactly this: a short press reaches the
   * page, and press-and-hold still leaves fullscreen, so nobody is ever
   * trapped. Chromium only; elsewhere this does nothing and M is the key.
   */
  useEffect(() => {
    const kb = (navigator as unknown as {
      keyboard?: { lock?: (keys: string[]) => Promise<void>; unlock?: () => void }
    }).keyboard
    if (!kb?.lock) return
    const sync = () => {
      if (document.fullscreenElement) void kb.lock!(['Escape']).catch(() => { /* not granted */ })
      else kb.unlock?.()
    }
    document.addEventListener('fullscreenchange', sync)
    sync()
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      kb.unlock?.()
    }
  }, [])

  // While open, using the panel keeps it open; left alone, it closes.
  useEffect(() => {
    if (!menuVisible) return
    const arm = () => {
      if (menuTimerRef.current) clearTimeout(menuTimerRef.current)
      menuTimerRef.current = setTimeout(() => setMenuVisible(false), MENU_IDLE_MS)
    }
    arm()
    window.addEventListener('pointermove', arm)
    window.addEventListener('pointerdown', arm)
    window.addEventListener('keydown', arm)
    return () => {
      window.removeEventListener('pointermove', arm)
      window.removeEventListener('pointerdown', arm)
      window.removeEventListener('keydown', arm)
      if (menuTimerRef.current) clearTimeout(menuTimerRef.current)
    }
  }, [menuVisible])

  // A brief pointer to the key when the display first loads, since
  // nothing on screen otherwise says the panel exists.
  useEffect(() => {
    const t = setTimeout(() => setShowHint(false), HINT_MS)
    return () => clearTimeout(t)
  }, [])

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

  // Both modes drive the layered renderer; wedflix adds the overlay.
  /**
   * A forced-column wall is showing posters, which are artwork: crop
   * them to fill and the title comes off. The automatic grid is showing
   * snapshots, where filling the cell looks better than letterboxing.
   */
  const wallFit = (view.columns ?? 0) > 0 ? 'object-contain' : 'object-cover'
  // The wall, with the 3D renderer in every cell.
  const wallCinematic = view.mode === 'wall' && view.effect === 'cinematic'

  const wedflixActive = view.effect === 'wedflix'
  const cinematicActive = view.effect === 'cinematic' || wedflixActive
  const cardCopy = (current?.card ?? null) as CardCopy | null

  // The browse card is for the day's own photographs. The seed selfies
  // are stand-ins shown until real ones arrive, and billing those as
  // programmes gives the joke away before the wedding has started — so
  // while the pool is still padded with them, they play as plain
  // cinematic and only the uploads get a card. No switch to remember:
  // Wedflix turns itself on as the photos come in.
  // The same rule the pool uses, so what is pooled for Wedflix and what
  // is drawn as Wedflix cannot drift apart.
  const wedflixCard = wedflixActive && !!current && hasBrowseCard(current)

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
      {view.mode === 'slideshow' ? (
        <div className="absolute inset-0">
          {/* Blurred cover fill — replaces dead black letterbox bars,
              and in cinematic mode it is what the melted-away
              background dissolves INTO. */}
          {settings.fillBars && current && !cinematicActive && (
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
          {current && cinematicActive ? (
            // Deliberately NOT keyed by photo: the renderer keeps one
            // canvas and one WebGL context for the whole display and
            // cross-fades between photos itself. Keying it here threw
            // the canvas away on every slide and left the screen on the
            // blurred fill until the next original had downloaded.
            <div className="absolute inset-0">
              <CinematicPhoto
                src={displaySrc(current)}
                plateSrc={current.variants?.plate ?? null}
                cutoutSrc={current.variants?.cutout ?? null}
                depthSrc={current.variants?.depth ?? null}
                fill={settings.fillBars}
                depthStrength={settings.depthStrength ?? 1}
                camera={view.camera}
                blurTransition={view.blurTransition ?? true}
                durationMs={Math.max(view.intervalMs, 2000)}
                className="absolute inset-0 w-full h-full"
              />
              {wedflixCard && cardCopy && (
                <WedflixCard
                  copy={cardCopy}
                  slideKey={current.id}
                  durationMs={Math.max(view.intervalMs, 2000)}
                  // A chart position on every card would stop being a
                  // joke by the third one.
                  showRank={rankFor(current.id)}
                />
              )}
            </div>
          ) : current ? (
            // eslint-disable-next-line @next/next/no-img-element -- projector shows originals full-screen
            <img
              key={current.id}
              // Sized for the screen, upscaled where available, and
              // resized by the CDN when one is configured — the same URL
              // the cinematic renderer uses. current.url is the untouched
              // original at full size.
              src={displaySrc(current)}
              alt={current.guest_name ? `Photo by ${current.guest_name}` : ''}
              className="absolute inset-0 w-full h-full object-contain"
              style={{ animation: slideAnimation(view.effect, current.id, view.intervalMs) }}
            />
          ) : null}
          {/* A browse card owns the whole frame and does not credit
              whoever filmed it. Keyed off the card actually being drawn,
              not the mode, so a seed selfie playing as plain cinematic
              keeps its credit. */}
          {current?.guest_name && !showQrSlide && !wedflixCard && (
            <div className="absolute bottom-6 left-6 flex items-center gap-2 text-white/70 text-xl drop-shadow">
              {/* house line-style (outline) camera icon — no emoji */}
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM18.75 10.5h.008v.008h-.008V10.5z" />
              </svg>
              <span>{current.guest_name}</span>
            </div>
          )}
          {pool.length === 0 && (
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
          className="absolute inset-0 grid"
          style={{
            gridTemplateColumns: `repeat(${wallLayoutFor(Math.max(pool.length, 1), view.columns).cols}, 1fr)`,
            gridTemplateRows: `repeat(${wallLayoutFor(Math.max(pool.length, 1), view.columns).rows}, 1fr)`,
          }}
        >
          {wallCells.map((cell, i) => (
            <div key={i} className="relative overflow-hidden bg-black">
              {/* A wall can be cinematic too: each cell runs the same
                  renderer as a full-screen slide, on its own photo. The
                  renderer cross-fades between photos itself, so the cell
                  keeps one instance and changes its layers (asked
                  2026-09-23). It is a 2D canvas, so a row of them costs
                  little. */}
              {wallCinematic && cell.current ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- ambient fill */}
                  <img src={cell.current.variants?.medium || cell.current.url} alt="" aria-hidden="true" className="bx-none bx-ambient-wall" style={{ position: 'absolute', inset: '-6%', width: '112%', height: '112%', objectFit: 'cover', filter: 'blur(38px) brightness(.45) saturate(1.2)' }} />
                  <CinematicPhoto
                    src={displaySrc(cell.current)}
                    plateSrc={cell.current.variants?.plate ?? null}
                    cutoutSrc={cell.current.variants?.cutout ?? null}
                    depthSrc={cell.current.variants?.depth ?? null}
                    fill={settings.fillBars}
                    depthStrength={settings.depthStrength ?? 1}
                    camera={view.camera}
                    blurTransition={view.blurTransition ?? true}
                    durationMs={Math.max(view.intervalMs, 2000)}
                    className="absolute inset-0 w-full h-full"
                  />
                </>
              ) : (<>
              {cell.previous && cell.previous.id !== cell.current?.id && (
                // Fades out as the new one fades in. It used to stay put
                // underneath, so a smaller incoming photo left the old one
                // showing round its edges (projector, 2026-09-22).
                <WallPicture
                  key={`out-${cell.previous.id}-${cell.current?.id ?? ''}`}
                  item={cell.previous}
                  fit={wallFit}
                  style={{ animation: 'emfadeout 900ms ease forwards' }}
                />
              )}
              {cell.current && (
                <WallPicture
                  key={cell.current.id}
                  item={cell.current}
                  fit={wallFit}
                  style={{ animation: slideAnimation(view.effect, cell.current.id, view.intervalMs) }}
                />
              )}
              </>)}
            </div>
          ))}
          {pool.length === 0 && (
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
      {showQrSlide && !showLive && qrDataUrl && view.mode === 'slideshow' && (
        <div className="absolute inset-0 bg-black/95 flex flex-col items-center justify-center gap-6 transition-opacity duration-700">
          {linkInfo?.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- event logo
            <img src={linkInfo.logoUrl} alt="" className="max-h-28 object-contain" />
          )}
          {/* eslint-disable-next-line @next/next/no-img-element -- data-URL QR */}
          <img src={qrDataUrl} alt="Upload QR" className="w-72 h-72 rounded-xl bg-white p-3" />
          <p className="text-white text-3xl font-light">{qrTab === 'booth' ? 'Scan to use the photo booth' : 'Scan to add your photos'}</p>
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

      {/* Corner QR + logo card. Top right so the bottom right belongs to
          the Wedflix wordmark, where a streaming service puts it. */}
      {/* The pose the whole room is being asked for. Bottom left, out of
          the way of the QR, and only while the booth is on screen. */}
      {posesInfo?.mode === 'hour' && posesInfo.current && activeStream === 'booth' && (
        <div className="absolute bottom-8 left-8 max-w-[34rem] rounded-2xl px-7 py-5 bg-black/55 backdrop-blur text-white shadow-2xl">
          <p className="text-lg uppercase tracking-[.2em] text-white/60">Everyone right now</p>
          <p className="text-5xl font-extrabold mt-1">{posesInfo.current.label}</p>
          <p className="text-2xl text-white/85 mt-1">{posesInfo.current.instruction}</p>
          {posesInfo.changes_at && posesInfo.next && (
            <p className="text-xl text-white/60 mt-3">
              Changes in {(() => {
                const left = Math.max(0, new Date(posesInfo.changes_at).getTime() - poseNow)
                return `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`
              })()} — next: {posesInfo.next.label}
            </p>
          )}
        </div>
      )}

      {qrCorner && (
        <div className="absolute top-6 right-6 bg-white/95 rounded-xl p-3 flex flex-col items-center gap-2 shadow-xl">
          {/* eslint-disable-next-line @next/next/no-img-element -- data-URL QR */}
          <img src={qrDataUrl} alt="Upload QR" className="w-32 h-32" />
          {linkInfo?.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- event logo
            <img src={linkInfo.logoUrl} alt="" className="max-h-10 object-contain" />
          )}
          <p className="text-[11px] text-gray-700 font-medium">Scan to add photos</p>
        </div>
      )}

      {/* Where the settings live, shown briefly on load. Bottom centre is
          the one corner of the screen nothing else uses: the QR has the
          top right, the Wedflix wordmark the bottom right, the uploader
          credit the bottom left. */}
      <div
        aria-hidden={!showHint}
        className="absolute left-1/2 -translate-x-1/2 transition-opacity duration-700 pointer-events-none"
        style={{
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 22px)',
          opacity: showHint && !menuVisible ? 1 : 0,
          background: 'rgba(0,0,0,.55)', color: 'rgba(255,255,255,.85)',
          padding: '.5em .9em', borderRadius: 999, fontSize: 13,
          backdropFilter: 'blur(6px)',
        }}
      >
        Press <kbd style={{ fontFamily: 'inherit', fontWeight: 600 }}>Esc</kbd> or{' '}
        <kbd style={{ fontFamily: 'inherit', fontWeight: 600 }}>M</kbd> for settings
      </div>

      {/* Settings panel. Sized for a laptop trackpad AND a phone held
          at arm's length next to a projector: one labelled row per
          setting, options on their own line so nothing clips, and the
          whole panel scrolls rather than overflowing the screen. */}
      <div
        className={`absolute top-3 right-3 left-3 sm:left-auto transition-opacity duration-300 ${menuVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      >
        <div data-menu className="ml-auto bg-black/80 backdrop-blur-md rounded-2xl shadow-2xl ring-1 ring-white/10 text-white w-full sm:w-[24rem] max-h-[86vh] overflow-y-auto">
          <div className="p-4 space-y-4">

            <Row label="Showing">
              {([
                ...VIEW_ORDER.map((v) => [v, VIEW_LABEL[v]] as const),
                ['mix', 'In turn'] as const,
              ]).map(([val, label]) => (
                <Chip
                  key={val}
                  on={settings.stream === val}
                  onClick={() => {
                    updateSettings({ stream: val })
                    // Picking a view opens its settings below, which is
                    // almost always what someone reaching for it wants.
                    if (val !== 'mix') setEditing(val)
                  }}
                >
                  {label}
                </Chip>
              ))}
            </Row>

            {settings.stream === 'mix' && (
              <Row label="Rotate through">
                {VIEW_ORDER.map((v) => {
                  const on = rotation.includes(v)
                  return (
                    <Chip
                      key={v}
                      on={on}
                      onClick={() => {
                        // Always at least one: an empty rotation would
                        // quietly fall back to the day and the booth.
                        if (on && rotation.length === 1) return
                        const next = on ? rotation.filter((x) => x !== v) : [...rotation, v]
                        updateSettings({ rotation: normaliseRotation(next) })
                      }}
                    >
                      {VIEW_LABEL[v]}
                    </Chip>
                  )
                })}
              </Row>
            )}

            {settings.stream === 'mix' && (
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs uppercase tracking-wide text-white/50">Swap every</span>
                  <span className="text-sm tabular-nums text-white/80">{settings.mixSeconds ?? 90}s</span>
                </div>
                <input
                  type="range" min={15} max={300} step={15}
                  value={settings.mixSeconds ?? 90}
                  onChange={(e) => updateSettings({ mixSeconds: Number(e.target.value) })}
                  className="w-full accent-white/80"
                />
                <p className="text-xs text-white/40">
                  Showing {VIEW_LABEL[activeStream]} now, each with its own settings below.
                  Albums with nothing to show yet are skipped.
                </p>
              </div>
            )}

            {/* Everything below belongs to ONE view, chosen here rather
                than inferred from the screen, so any view can be set up
                at any time -- Preload ahead of the day, the booth while
                the day is showing. */}
            <div className="pt-1 border-t border-white/10" />
            <Row label="Settings for">
              {VIEW_ORDER.map((val) => (
                <Chip key={val} on={editing === val} onClick={() => setEditing(val)}>
                  {VIEW_LABEL[val]}
                </Chip>
              ))}
            </Row>

            <Row label="Display">
              {(['slideshow', 'wall'] as const).map((m) => (
                <Chip key={m} on={edited.mode === m} onClick={() => updateStream({ mode: m })}>
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
                // Not offered for Preload: selfies are never billed as
                // programmes, so it would show nothing but stand-ins with
                // their cards missing.
                ...(editing === 'preload' ? [] : [['wedflix', 'Wedflix'] as const]),
                ['cinematic', 'Cinematic'],
                ['kenburns', 'Ken Burns'],
                ['grade', 'B&W bloom'],
                ['fade', 'Fade'],
                ['slide', 'Slide'],
                ['zoom', 'Zoom'],
                ['blur', 'Blur'],
              ] as const).map(([val, label]) => (
                <Chip key={val} on={edited.effect === val} onClick={() => updateStream({ effect: val })}>
                  {label}
                </Chip>
              ))}
            </Row>

            {(edited.effect === 'cinematic' || edited.effect === 'wedflix') && (
              <Row label="Transition">
                <Toggle
                  on={edited.blurTransition ?? true}
                  onClick={() => updateStream({ blurTransition: !(edited.blurTransition ?? true) })}
                >
                  Blur dissolve
                </Toggle>
              </Row>
            )}

            {edited.effect === 'cinematic' && (
              <div className="space-y-1.5 -mt-1">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs uppercase tracking-wide text-white/50">3D separation</span>
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
                  How far the people separate from the background. Photos whose layers are still
                  generating get a plain camera move.
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


            <Row label="Camera">
              {([
                ['pan', 'Pan'],
                ['panzoom', 'Pan + zoom'],
              ] as const).map(([val, label]) => (
                <Chip
                  key={val}
                  on={edited.camera === val}
                  onClick={() => updateSettings({ camera: val })}
                >
                  {label}
                </Chip>
              ))}
            </Row>

            <Row label="Look">
              <Toggle on={settings.ambient} onClick={() => updateSettings({ ambient: !settings.ambient })}>Ambient colour</Toggle>
              <Toggle on={settings.fillBars} onClick={() => updateSettings({ fillBars: !settings.fillBars })}>Blurred fill</Toggle>
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
                <span className="text-sm tabular-nums text-white/80">{edited.intervalMs / 1000}s</span>
              </div>
              <input
                type="range"
                min={4}
                max={30}
                value={edited.intervalMs / 1000}
                onChange={(e) => updateStream({ intervalMs: Number(e.target.value) * 1000 })}
                className="w-full accent-white/80"
              />
            </div>

            {edited.mode === 'wall' && (
              <Row label="Across">
                {([[0, 'Best fit'], [2, 'Two'], [3, 'Three'], [4, 'Four']] as const).map(([n, label]) => (
                  <Chip key={n} on={(edited.columns ?? 0) === n} onClick={() => updateStream({ columns: n })}>
                    {label}
                  </Chip>
                ))}
              </Row>
            )}

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
