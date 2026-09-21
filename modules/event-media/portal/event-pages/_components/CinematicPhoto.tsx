'use client'

// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * Cinematic photo renderer — layered 3D.
 *
 * Each photo is drawn as two complete layers that move at different
 * rates:
 *
 *   plate   the scene with the people removed and the background
 *           reconstructed behind them — the far layer
 *   cutout  the people on their own with a soft alpha edge — the near
 *           layer
 *
 * That difference IS the depth. Because both layers are complete, the
 * background revealed as the camera drifts is real reconstructed
 * scene, so nothing smears and no edge tears.
 *
 * This replaces a depth-map displacement approach that was rightly
 * criticised for exactly that: it shifted one flat image by its depth
 * map, and since there was nothing behind the subject it stretched
 * whatever pixels were adjacent, producing torn cutouts. It also
 * stacked heavy defocus and desaturation on top, which flattened the
 * backgrounds. All of that is gone.
 *
 * The camera is aimed at the PEOPLE, not the frame. The aim point is
 * measured from the cutout's own alpha channel — bounding box of the
 * subject, then a little above its centre, where heads sit — so the
 * move pushes toward faces instead of drifting off into a corner.
 *
 * Layers are fetched, never computed here. The API generates them once
 * per photo and caches them; running models in the browser froze the
 * display for seconds at a time.
 *
 * Degrades at every step: no cutout or plate → the photo gets a plain
 * camera move; no WebGL at all → the caller falls back to CSS effects.
 */

import { useEffect, useRef } from 'react'

interface Props {
  /** Current photo. Changing this cross-fades to the new one. */
  src: string
  /** Scene with the people removed. Absent → single-layer move. */
  plateSrc?: string | null
  /** The people, alpha cut out. Absent → single-layer move. */
  cutoutSrc?: string | null
  /** 0 flattens to a plain camera move; 1 is the tuned default. */
  depthStrength?: number
  /** Slide duration; the camera move is timed against it. */
  durationMs: number
  className?: string
}

const FADE_MS = 900

/**
 * Separation between the layers, as a fraction of the frame. The near
 * layer travels this much further than the far one over a whole slide.
 * Small numbers read as depth; large ones read as a mistake.
 */
const SEPARATION = 0.055

/** Camera moves. Pan is a fraction of the slack the zoom creates, so a
 *  move can never wander off the edge of the photo. */
interface Move { z0: number; z1: number; x0: number; y0: number; x1: number; y1: number }

/**
 * Zooms deliberately match the Ken Burns keyframes in DisplayView
 * (1.02 to 1.12), which is the distance the camera is wanted at. They
 * ran 1.06 to 1.24 on top of a cover-fit, which read as far too close.
 */
const MOVES: Move[] = [
  { z0: 1.02, z1: 1.12, x0: 0, y0: 0, x1: 0, y1: 0 },
  { z0: 1.12, z1: 1.02, x0: 0, y0: 0, x1: 0, y1: 0 },
  { z0: 1.04, z1: 1.10, x0: -0.8, y0: 0, x1: 0.8, y1: 0 },
  { z0: 1.10, z1: 1.04, x0: 0.8, y0: 0, x1: -0.8, y1: 0 },
  { z0: 1.03, z1: 1.12, x0: -0.6, y0: 0.5, x1: 0.4, y1: -0.4 },
  { z0: 1.12, z1: 1.03, x0: 0.5, y0: -0.5, x1: -0.3, y1: 0.3 },
  { z0: 1.05, z1: 1.13, x0: 0.4, y0: 0.5, x1: -0.2, y1: -0.2 },
  { z0: 1.09, z1: 1.03, x0: 0, y0: -0.6, x1: 0, y1: 0.6 },
]

/** Same photo always gets the same move; different photos differ. */
function moveFor(src: string): Move {
  let h = 0
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) | 0
  return MOVES[Math.abs(h) % MOVES.length]!
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const i = new window.Image()
    i.crossOrigin = 'anonymous'
    i.onload = () => resolve(i)
    i.onerror = () => resolve(null)
    i.src = src
  })
}

/**
 * Where the people are, from the cutout's alpha. Returns the aim point
 * in 0..1 image coordinates, biased up the subject's bounding box so
 * the camera favours heads over torsos.
 */
function aimFromCutout(img: HTMLImageElement): { x: number; y: number } {
  const fallback = { x: 0.5, y: 0.42 }
  try {
    // A coarse scan is plenty — this only needs to find a bounding box.
    const w = Math.min(img.naturalWidth, 240)
    const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return fallback
    ctx.drawImage(img, 0, 0, w, h)
    const d = ctx.getImageData(0, 0, w, h).data
    let minX = w, maxX = 0, minY = h, maxY = 0, seen = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3]! > 48) {
          seen++
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    // Too little subject to trust, or nearly the whole frame — neither
    // gives a meaningful aim point.
    const coverage = seen / (w * h)
    if (coverage < 0.01 || coverage > 0.97 || maxX <= minX) return fallback
    return {
      x: (minX + maxX) / 2 / w,
      y: (minY + (maxY - minY) * 0.3) / h,
    }
  } catch {
    return fallback
  }
}

interface Layer {
  photo: HTMLImageElement
  plate: HTMLImageElement | null
  cutout: HTMLImageElement | null
  aim: { x: number; y: number }
  startedAt: number
  move: Move
  src: string
}

export default function CinematicPhoto({
  src, plateSrc, cutoutSrc, depthStrength = 1, durationMs, className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const curRef = useRef<Layer | null>(null)
  const prevRef = useRef<Layer | null>(null)
  const fadeFromRef = useRef(0)

  // Read by the render loop without restarting it.
  const durationRef = useRef(durationMs)
  const strengthRef = useRef(depthStrength)
  durationRef.current = durationMs
  strengthRef.current = depthStrength

  // ── One canvas, one loop, for the whole display ───────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return
    let disposed = false

    /**
     * How much of the frame to fill.
     *
     * This used to cover-fit the stage, which put the camera far closer
     * to the subject than Ken Burns does and was the effect's most
     * common complaint. The two are not reconcilable at full cover: a
     * 4:3 photo cover-fitted into 16:9 is already cropped to 1.33x
     * before any move is applied, where Ken Burns letterboxes and never
     * exceeds 1.12x. Matching that framing means sitting near `contain`.
     *
     * OVERSCAN is the small amount past fitting that keeps the frame
     * edges off-screen through the pan; the blurred backdrop fills the
     * rest of the stage, so the screen is never empty.
     */
    const OVERSCAN = 1.04
    const fitScale = (img: HTMLImageElement, w: number, h: number) => {
      const contain = Math.min(w / img.naturalWidth, h / img.naturalHeight)
      return contain * OVERSCAN
    }

    /**
     * Draw one layer so that `aim` sits at the same screen point
     * whatever the zoom, then offset it.
     */
    const drawImage = (
      img: HTMLImageElement, aim: { x: number; y: number },
      zoom: number, dx: number, dy: number, w: number, h: number, alpha: number,
    ) => {
      const scale = fitScale(img, w, h) * zoom
      const iw = img.naturalWidth * scale
      const ih = img.naturalHeight * scale
      const x = w / 2 - aim.x * iw + dx
      const y = h / 2 - aim.y * ih + dy
      ctx.globalAlpha = alpha
      ctx.drawImage(img, x, y, iw, ih)
      ctx.globalAlpha = 1
    }

    const drawLayer = (layer: Layer, now: number, w: number, h: number, alpha: number) => {
      const t = (now - layer.startedAt) / Math.max(durationRef.current, 2000)
      // Linear, like a real camera move; easing makes the middle rush.
      const k = Math.max(0, Math.min(1, t))
      const m = layer.move
      const zoom = lerp(m.z0, m.z1, k)
      const slack = Math.max(0, (1 - 1 / zoom) / 2)
      const panX = lerp(m.x0, m.x1, k) * slack * w
      const panY = lerp(m.y0, m.y1, k) * slack * h

      const strength = Math.max(0, Math.min(2, strengthRef.current))
      const layered = Boolean(layer.plate && layer.cutout) && strength > 0.001

      if (!layered) {
        drawImage(layer.photo, layer.aim, zoom, panX, panY, w, h, alpha)
        return
      }

      // The near layer travels further than the far one. That
      // difference, and nothing else, is the depth.
      const spread = SEPARATION * strength * w
      const bg = -spread * (lerp(m.x0, m.x1, k))
      const bgY = -spread * (lerp(m.y0, m.y1, k)) * (h / w)
      drawImage(layer.plate!, layer.aim, zoom * 1.04, panX + bg, panY + bgY, w, h, alpha)
      drawImage(layer.cutout!, layer.aim, zoom, panX, panY, w, h, alpha)
    }

    const frame = (now: number) => {
      if (disposed) return
      rafRef.current = requestAnimationFrame(frame)
      const cur = curRef.current
      if (!cur) return

      // Render at the display's real pixels. Measure the PARENT and pin
      // the canvas CSS size from it — sizing the backing store from the
      // canvas's own clientWidth is a feedback loop that doubles every
      // frame at dpr 2.
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const host = canvas.parentElement
      const rect = host?.getBoundingClientRect()
      const cssW = Math.max(1, Math.min(Math.round(rect?.width || 1920), 4096))
      const cssH = Math.max(1, Math.min(Math.round(rect?.height || 1080), 2304))
      if (canvas.style.width !== `${cssW}px`) canvas.style.width = `${cssW}px`
      if (canvas.style.height !== `${cssH}px`) canvas.style.height = `${cssH}px`
      const w = Math.round(cssW * dpr)
      const h = Math.round(cssH * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }

      ctx.clearRect(0, 0, w, h)

      const prev = prevRef.current
      const f = prev ? Math.min(1, (now - fadeFromRef.current) / FADE_MS) : 1
      // The outgoing photo is drawn at full strength and the incoming
      // one dissolves over it, so nothing shows through mid-transition.
      if (prev && f < 1) drawLayer(prev, now, w, h, 1)
      drawLayer(cur, now, w, h, f)
      if (prev && f >= 1) prevRef.current = null
    }
    rafRef.current = requestAnimationFrame(frame)

    return () => {
      disposed = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      curRef.current = null
      prevRef.current = null
    }
  }, [])

  // ── Swap in a new photo, once its layers are actually ready ───────
  useEffect(() => {
    let cancelled = false
    void (async () => {
      // The layers are optional. A photo whose plate or cutout has not
      // been generated yet still gets its camera move, so a fresh
      // upload is never held off the screen waiting for them.
      const [photo, plate, cutout] = await Promise.all([
        loadImage(src),
        plateSrc ? loadImage(plateSrc) : Promise.resolve(null),
        cutoutSrc ? loadImage(cutoutSrc) : Promise.resolve(null),
      ])
      if (cancelled || !photo) return

      curRef.current && (prevRef.current = curRef.current)
      curRef.current = {
        photo,
        plate,
        cutout,
        aim: cutout ? aimFromCutout(cutout) : { x: 0.5, y: 0.42 },
        startedAt: performance.now(),
        move: moveFor(src),
        src,
      }
      fadeFromRef.current = performance.now()
    })()
    return () => { cancelled = true }
  }, [src, plateSrc, cutoutSrc])

  return <canvas ref={canvasRef} className={className} />
}
