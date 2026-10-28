'use client'

// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * An album played as a slideshow, in the order the photographs were taken.
 *
 * Offered on albums the organiser has turned it on for (migration 033):
 * a photographer's full delivery is thousands of frames shot in bursts,
 * and at two or three a second it reads almost as film (asked
 * 2026-10-28). The viewer chooses the speed.
 *
 * Frames come from the gallery API a page at a time, oldest first, and
 * are shown through the CDN at a size for the screen. The next few
 * seconds are loaded and decoded ahead of the one on screen; if the
 * network falls behind, the picture waits for the next frame rather
 * than skipping it, and says so. Only a small window of frames is kept
 * in memory either side of the one showing.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { fullFaceOf } from './_lib/gallery-face'
import {
  FRAME_PAGE, SPEEDS, type Speed, DEFAULT_SPEED, frameMs, frameUrl, frameWidth, keepWindow, nextFrame, pageStart, playFrom, playLength, speedOf,
} from './_lib/slideshow'

const API_BASE = ''
/** How long the controls stay up after the pointer last moved. */
const CONTROLS_MS = 2500
const SPEED_KEY = 'event_media_slideshow_speed'

interface Frame {
  id: string
  kind: 'photo' | 'video'
  url: string
  original?: { url: string } | null
}

interface Props {
  eventIdentifier: string
  /** The album's slug, as the gallery is asked for it. */
  album: string
  albumName: string
  /** Frames in the album, from the gallery's own count. */
  total: number
  /** Show the improved copies where the album has them. */
  enhanced: boolean
  onClose: () => void
}

export default function SlideshowPlayer({ eventIdentifier, album, albumName, total: totalIn, enhanced, onClose }: Props) {
  const [index, setIndex] = useState(0)
  const [total, setTotal] = useState(totalIn)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState<Speed>(() => {
    try { return speedOf(localStorage.getItem(SPEED_KEY)) } catch { return DEFAULT_SPEED }
  })
  const [waiting, setWaiting] = useState(false)
  const [controls, setControls] = useState(true)
  const [shown, setShown] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  // Frames by position, filled a page at a time. A ref, because the
  // player reads it on every tick and nothing re-renders from it.
  const frames = useRef<Map<number, Frame>>(new Map())
  const pagesAsked = useRef<Set<number>>(new Set())
  // Decoded images by position, and which of them are ready.
  const loaded = useRef<Map<number, HTMLImageElement>>(new Map())
  const ready = useRef<Set<number>>(new Set())
  // Positions that are not a frame at all: a video, or a photograph that
  // would not load. Stepped over rather than waited for.
  const skip = useRef<Set<number>>(new Set())
  // The index as the timer sees it, without waiting for a render.
  const at = useRef(0)
  const width = useRef(960)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    width.current = frameWidth(window.innerWidth, window.innerHeight, window.devicePixelRatio)
  }, [])

  const urlOf = useCallback((f: Frame): string => {
    const full = fullFaceOf({ url: f.url, original: f.original ?? null, variants: null }, { enhanced })
    return frameUrl(full, width.current)
  }, [enhanced])

  const loadPage = useCallback(async (offset: number) => {
    if (pagesAsked.current.has(offset)) return
    pagesAsked.current.add(offset)
    try {
      const qs = new URLSearchParams({ album, sort: 'oldest', limit: String(FRAME_PAGE), offset: String(offset) })
      const res = await fetch(`${API_BASE}/api/public/event-media/events/${encodeURIComponent(eventIdentifier)}/gallery?${qs}`)
      if (!res.ok) throw new Error(`gallery ${res.status}`)
      const data = await res.json()
      if (typeof data.total === 'number') setTotal(data.total)
      ;(data.items ?? []).forEach((item: Frame, n: number) => {
        // A video in the album is passed over: it is not a frame.
        if (item.kind === 'photo') frames.current.set(offset + n, item)
        else skip.current.add(offset + n)
      })
    } catch {
      // Asked again next time it is needed.
      pagesAsked.current.delete(offset)
      if (offset === 0) setFailed(true)
    }
  }, [album, eventIdentifier])

  // The latest fill, for a page that lands after the call that asked for it.
  const fillRef = useRef<(pos: number) => void>(() => {})

  // Load and decode the frames around the one showing; let go of the rest.
  const fill = useCallback((pos: number) => {
    const { from, to } = keepWindow(pos, speed, total)
    for (const page of new Set([pageStart(from), pageStart(to)])) {
      // A page not here yet fills again when it lands. Otherwise a jump
      // made while paused (the slider, a step back) would wait for ever.
      if (!pagesAsked.current.has(page)) void loadPage(page).then(() => fillRef.current(at.current))
    }
    for (let i = from; i <= to; i++) {
      const f = frames.current.get(i)
      if (!f || loaded.current.has(i)) continue
      const img = new Image()
      img.decoding = 'async'
      img.src = urlOf(f)
      loaded.current.set(i, img)
      img.decode().then(() => {
        // Let go of while it was loading: nothing to do.
        if (loaded.current.get(i) !== img) return
        ready.current.add(i)
        // The frame being waited for has arrived: show it now rather
        // than on the next tick.
        if (i === at.current) { setShown(img.src); setWaiting(false) }
      }).catch(() => {
        // A frame that will not load is skipped rather than waited for.
        frames.current.delete(i)
        skip.current.add(i)
      })
    }
    for (const i of [...loaded.current.keys()]) {
      if (i < from || i > to) { loaded.current.delete(i); ready.current.delete(i) }
    }
  }, [loadPage, speed, total, urlOf])
  fillRef.current = fill

  // What is on screen follows the index once its frame is ready; until
  // then the decode above puts it up when it lands.
  useEffect(() => {
    at.current = index
    fill(index)
    const f = frames.current.get(index)
    if (f && ready.current.has(index)) setShown(urlOf(f))
  }, [index, fill, urlOf])

  // Playing: one step per tick, but only onto a frame that is ready.
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      const step = nextFrame(at.current, total, skip.current, (i) => frames.current.has(i) && ready.current.has(i))
      if (step.kind === 'end') { setPlaying(false); return }
      fill(step.index)
      if (step.kind === 'wait') { setWaiting(true); return }
      setWaiting(false)
      setIndex(step.index)
    }, frameMs(speed))
    return () => clearInterval(timer)
  }, [playing, speed, total, fill])

  // Paused when the tab is not being looked at.
  useEffect(() => {
    const onHide = () => { if (document.hidden) setPlaying(false) }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [])

  const poke = useCallback(() => {
    setControls(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setControls(false), CONTROLS_MS)
  }, [])
  useEffect(() => { poke(); return () => { if (hideTimer.current) clearTimeout(hideTimer.current) } }, [poke])

  const step = useCallback((by: number) => {
    setPlaying(false)
    setWaiting(false)
    setIndex(Math.max(0, Math.min(total - 1, at.current + by)))
  }, [total])

  // Play from where it is, or from the top once it has finished.
  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (p) return false
      const from = playFrom(at.current, total)
      if (from !== at.current) setIndex(from)
      return true
    })
  }, [total])

  const chooseSpeed = useCallback((s: Speed) => {
    setSpeed(s)
    try { localStorage.setItem(SPEED_KEY, String(s)) } catch { /* not remembered, still set */ }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      poke()
      if (e.key === 'Escape') onClose()
      else if (e.key === ' ') { e.preventDefault(); toggle() }
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, poke, step, toggle])

  const chip = (on: boolean) => (on
    ? { background: '#ffffff', color: '#111827', fontWeight: 600 }
    : { background: 'rgba(255,255,255,0.14)', color: 'rgba(255,255,255,0.9)' })

  return (
    <div
      data-event-media-overlay=""
      role="dialog"
      aria-label={`${albumName} as a slideshow`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black"
      style={{ cursor: controls ? 'default' : 'none' }}
      onPointerMove={poke}
      onClick={() => { poke(); toggle() }}
    >
      {shown && (
        // eslint-disable-next-line @next/next/no-img-element -- frames are preloaded Image objects; next/image would refetch
        <img src={shown} alt="" className="max-h-full max-w-full object-contain select-none" draggable={false} />
      )}
      {!shown && !failed && <p className="text-sm text-white/70">Loading the photos…</p>}
      {failed && <p className="text-sm text-white/70">The photos could not be loaded just now.</p>}
      {waiting && playing && (
        <p className="absolute top-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-white/80">
          Loading…
        </p>
      )}

      <div
        className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-4 pb-4 pt-10 transition-opacity"
        style={{ opacity: controls || !playing ? 1 : 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="range"
          min={0}
          max={Math.max(total - 1, 0)}
          value={index}
          onChange={(e) => { setPlaying(false); setIndex(Number(e.target.value)) }}
          aria-label="Position in the album"
          className="w-full"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-white">
          <button
            onClick={toggle}
            aria-label={playing ? 'Pause' : 'Play'}
            className="rounded-full px-3 py-1.5"
            style={chip(true)}
          >
            {playing ? 'Pause' : 'Play'}
          </button>
          <span className="text-white/60">Per second:</span>
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => chooseSpeed(s)}
              aria-pressed={s === speed}
              className="rounded-full px-2.5 py-1"
              style={chip(s === speed)}
            >
              {s}
            </button>
          ))}
          <span className="flex-1" />
          <span className="text-xs text-white/60">
            {Math.min(index + 1, total)} of {total} · {playLength(total, speed)}
          </span>
          <button
            onClick={onClose}
            aria-label="Close the slideshow"
            className="rounded-full px-3 py-1.5"
            style={chip(false)}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
