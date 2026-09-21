'use client'

// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * Cinematic photo renderer — layered 3D.
 *
 * Each photo is drawn as two complete layers:
 *
 *   plate   the scene with the people removed and the background
 *           reconstructed behind them — the far layer
 *   cutout  the people on their own with a soft alpha edge — the near
 *           layer
 *
 * It is shot like a tracking move: the camera follows the people, so
 * they hold still and the world slides behind them. That relative
 * motion IS the depth. Because both layers are complete, the background
 * revealed as the scene travels is real reconstructed scene, so nothing
 * smears and no edge tears.
 *
 * The photograph's window on the stage is pinned for the whole slide
 * and the background is drawn larger than it and clipped to it, so the
 * background can travel without its own edges ever entering the frame
 * and the letterbox bars never budge.
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
  /** 'pan' tracks across at a fixed size; 'panzoom' adds a push-in. */
  camera?: 'pan' | 'panzoom'
  /** Slide duration; the camera move is timed against it. */
  durationMs: number
  className?: string
}

const FADE_MS = 900

/**
 * How much larger the background is drawn than the photograph's window.
 *
 * This is the room the background has to travel in. It is spent
 * entirely on movement: because the layer is clipped to the window, the
 * extra is never visible as extra size, only as the distance the scene
 * can slide before an edge would reach the frame. Half of it is
 * available in each direction, so 1.12 buys a little over 5% of the
 * photo's width each way.
 *
 * Larger would travel further but pushes the background out of scale
 * with the people standing in front of it, and the seam starts to show.
 */
const PLATE_OVERSCAN = 1.12

/** Camera moves. Pan is a fraction of the slack the zoom creates, so a
 *  move can never wander off the edge of the photo. */
interface Move { z0: number; z1: number; x0: number; y0: number; x1: number; y1: number }

/**
 * Pure pans: the zoom holds still and the camera tracks across.
 *
 * The parallax is what makes this effect worth having, and a pan shows
 * it where a zoom hides it — sliding sideways, the background visibly
 * moves past the people, where growing merely scales them together.
 * Every move ends at 0, so a slide settles with the aim point, and
 * therefore the faces, as centred as the frame allows.
 *
 * `zoom` remains per-move so the Pan + zoom setting can reintroduce it.
 */
const MOVES: Move[] = [
  { z0: 1, z1: 1, x0: -1, y0: 0, x1: 1, y1: 0 },
  { z0: 1, z1: 1, x0: 1, y0: 0, x1: -1, y1: 0 },
  { z0: 1, z1: 1, x0: -0.9, y0: -0.5, x1: 0.9, y1: 0.5 },
  { z0: 1, z1: 1, x0: 0.9, y0: 0.5, x1: -0.9, y1: -0.5 },
  { z0: 1, z1: 1, x0: -1, y0: 0.4, x1: 0.6, y1: -0.4 },
  { z0: 1, z1: 1, x0: 1, y0: -0.4, x1: -0.6, y1: 0.4 },
  { z0: 1, z1: 1, x0: 0, y0: -1, x1: 0, y1: 1 },
  { z0: 1, z1: 1, x0: -0.6, y0: 0.8, x1: 0.8, y1: -0.6 },
]

/** Pan + zoom adds a slow push-in on top, inside the Ken Burns range. */
const ZOOM_IN = { z0: 1.0, z1: 1.06 }

/** Apply the camera setting to a move. */
function moveWith(m: Move, camera: 'pan' | 'panzoom'): Move {
  return camera === 'panzoom' ? { ...m, ...ZOOM_IN } : m
}

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
  src, plateSrc, cutoutSrc, depthStrength = 1, camera = 'pan', durationMs, className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const curRef = useRef<Layer | null>(null)
  const prevRef = useRef<Layer | null>(null)
  const fadeFromRef = useRef(0)

  // Read by the render loop without restarting it.
  const durationRef = useRef(durationMs)
  const strengthRef = useRef(depthStrength)
  const cameraRef = useRef(camera)
  cameraRef.current = camera
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
     * rest of the stage, so the screen is never empty. It is also the
     * headroom the face-aim needs: with nothing outside the stage there
     * is nothing to aim with, and the camera cannot favour the people.
     */
    const OVERSCAN = 1.06
    const fitScale = (img: HTMLImageElement, w: number, h: number) => {
      const contain = Math.min(w / img.naturalWidth, h / img.naturalHeight)
      return contain * OVERSCAN
    }

    /**
     * Place one axis.
     *
     * `want` aims the camera; this decides how much of that aim is
     * affordable. Where the image is bigger than the stage it may slide
     * only as far as its own overflow, so an edge can never come into
     * frame — without this, aiming at faces (which sit above centre)
     * pushed the image down and left a border along the top. Where the
     * image is smaller it is centred, so the letterbox is symmetric,
     * which is what Ken Burns does.
     */
    /**
     * Place one axis.
     *
     * `pan` arrives as -1..1 and is mapped to whatever room this axis
     * actually has, rather than to the zoom. The camera no longer zooms,
     * so deriving the travel from the zoom would mean no travel at all.
     *
     * Where the image overhangs the stage it may slide only as far as
     * that overhang, so an edge can never come into frame — this is also
     * what keeps the face-aim from opening a border along the top.
     * Where the image is letterboxed it drifts around centre instead,
     * within the bar, which is what the Ken Burns translate does.
     */
    const place = (
      size: number, stage: number, aim: number, pan: number, nudge: number,
    ) => {
      const over = size - stage
      if (over <= 0) {
        const centre = (stage - size) / 2
        // 0.6 keeps a margin, so a drift never runs the photo off-stage.
        return centre + pan * centre * 0.6 + nudge
      }
      return Math.max(-over, Math.min(0, aim + pan * (over / 2) + nudge))
    }

    /**
     * Draw one layer so that `aim` sits at the same screen point
     * whatever the zoom, then offset it.
     */
    const drawImage = (
      img: HTMLImageElement, aim: { x: number; y: number }, zoom: number,
      panX: number, panY: number, nudgeX: number, nudgeY: number,
      w: number, h: number, alpha: number,
    ) => {
      const scale = fitScale(img, w, h) * zoom
      const iw = img.naturalWidth * scale
      const ih = img.naturalHeight * scale
      const x = place(iw, w, w / 2 - aim.x * iw, panX, nudgeX)
      const y = place(ih, h, h / 2 - aim.y * ih, panY, nudgeY)
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
      // Normalised travel, mapped to each axis's own room by `place`.
      const panX = lerp(m.x0, m.x1, k)
      const panY = lerp(m.y0, m.y1, k)

      const strength = Math.max(0, Math.min(2, strengthRef.current))
      const layered = Boolean(layer.plate && layer.cutout) && strength > 0.001

      // No layers to separate, so there is nothing to hold still: the
      // whole photograph drifts, which is the Ken Burns behaviour.
      if (!layered) {
        drawImage(layer.photo, layer.aim, zoom, panX, panY, 0, 0, w, h, alpha)
        return
      }

      /*
       * A tracking shot: the camera follows the people, so THEY stay
       * put and the world slides behind them. Moving both and relying
       * on the small difference between them, as this did before, spent
       * most of the motion budget dragging the subject around the
       * screen for no gain.
       *
       * The obvious objection is that panning the background drags its
       * edges into frame. It does not, because the photograph's own
       * window is pinned for the whole slide and the background is
       * drawn larger than that window, then clipped to it. The
       * background travels inside a frame that never moves, so no edge
       * can appear and the letterbox bars stay rock steady.
       */
      const scale = fitScale(layer.cutout!, w, h) * zoom
      const iw = layer.cutout!.naturalWidth * scale
      const ih = layer.cutout!.naturalHeight * scale
      const wx = place(iw, w, w / 2 - layer.aim.x * iw, 0, 0)
      const wy = place(ih, h, h / 2 - layer.aim.y * ih, 0, 0)

      ctx.save()
      ctx.beginPath()
      ctx.rect(wx, wy, iw, ih)
      ctx.clip()

      // Spare is what the background has to travel within. Depth
      // strength scales how much of it a slide actually uses, so 0 is a
      // still photograph and 1 the tuned default.
      // 0.97 rather than 1: at full travel the background lands exactly
      // on the window edge, and sub-pixel rounding there can flash a
      // hairline seam. The margin costs nothing visible.
      const travel = Math.min(1, strength) * 0.97
      const spareX = (iw * (PLATE_OVERSCAN - 1)) / 2
      const spareY = (ih * (PLATE_OVERSCAN - 1)) / 2
      ctx.globalAlpha = alpha
      ctx.drawImage(
        layer.plate!,
        wx - spareX + panX * travel * spareX,
        wy - spareY + panY * travel * spareY,
        iw * PLATE_OVERSCAN,
        ih * PLATE_OVERSCAN,
      )
      // The people, exactly where the window puts them, every frame.
      ctx.drawImage(layer.cutout!, wx, wy, iw, ih)
      ctx.globalAlpha = 1
      ctx.restore()
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
        move: moveWith(moveFor(src), cameraRef.current),
        src,
      }
      fadeFromRef.current = performance.now()
    })()
    return () => { cancelled = true }
  }, [src, plateSrc, cutoutSrc])

  return <canvas ref={canvasRef} className={className} />
}
