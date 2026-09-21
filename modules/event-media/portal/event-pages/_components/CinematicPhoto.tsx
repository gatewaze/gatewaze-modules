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
  /**
   * Depth map, brighter nearer. Not drawn: it is the independent
   * witness the cutout is checked against before any parallax is
   * trusted.
   */
  depthSrc?: string | null
  /** 0 flattens to a plain camera move; 1 is the tuned default. */
  depthStrength?: number
  /** 'pan' tracks across at a fixed size; 'panzoom' adds a push-in. */
  camera?: 'pan' | 'panzoom'
  /** Soften the incoming photo through the dissolve. */
  blurTransition?: boolean
  /** Paint a blurred, darkened copy of the photo across the whole stage. */
  fill?: boolean
  /** Slide duration; the camera move is timed against it. */
  durationMs: number
  className?: string
}

const FADE_MS = 900

/** How soft the incoming photo starts when the blur transition is on. */
const BLUR_MAX_PX = 16

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

/**
 * Did the inpainting actually remove the people?
 *
 * Sometimes it does not. A tight selfie leaves the model almost no
 * background to reconstruct, so it returns the photograph more or less
 * unchanged — and the renderer then slides a cutout of the people over
 * a background that still contains them, which reads as a smeared
 * double exposure.
 *
 * Comparing the plate with the original INSIDE the subject's own mask
 * catches it: if those pixels barely changed, nobody was removed.
 * Returns the mean absolute difference, 0..255.
 */
function plateChange(
  photo: HTMLImageElement,
  plate: HTMLImageElement,
  cutout: HTMLImageElement,
): number {
  try {
    const w = 128
    const h = Math.max(1, Math.round((photo.naturalHeight / photo.naturalWidth) * w))
    const read = (img: HTMLImageElement) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d', { willReadFrequently: true })
      if (!g) return null
      g.drawImage(img, 0, 0, w, h)
      return g.getImageData(0, 0, w, h).data
    }
    const a = read(photo)
    const b = read(plate)
    const m = read(cutout)
    if (!a || !b || !m) return 255

    let sum = 0
    let n = 0
    for (let i = 0; i < w * h; i++) {
      if (m[i * 4 + 3]! < 160) continue
      const la = 0.299 * a[i * 4]! + 0.587 * a[i * 4 + 1]! + 0.114 * a[i * 4 + 2]!
      const lb = 0.299 * b[i * 4]! + 0.587 * b[i * 4 + 1]! + 0.114 * b[i * 4 + 2]!
      sum += Math.abs(la - lb)
      n++
    }
    // Too small a mask to judge; let the layers through rather than
    // flattening a photo on no evidence.
    if (n < 64) return 255
    return sum / n
  } catch {
    return 255
  }
}

/**
 * Below this the plate still contains the people.
 *
 * Measured against the live album of 140 layered photos, then checked
 * by eye at the boundary: plates scoring 4.5, 14.9, 23.4 and 31.5 still
 * had their subjects entirely intact, while 36.4 and 44.8 were properly
 * reconstructed. 35 sits in that gap and flattens 12 photos, every one
 * of them a selfie — which is exactly where the failure was reported.
 *
 * Erring high is deliberate. A photo wrongly flattened merely loses its
 * parallax and still looks like a photograph; a plate wrongly trusted
 * slides the people over themselves and looks broken.
 */
const PLATE_MIN_CHANGE = 35

/**
 * Does the cutout agree with the depth map?
 *
 * The renderer treats everything inside the cutout as near and
 * everything outside it as far. Where that contradicts the depth map
 * the pan goes wrong in one of two ways, both seen on the projector:
 *
 *   nearOutside  near pixels left OUT of the cutout. A drink held up to
 *                the camera, or the floor under someone's feet, becomes
 *                background and slides behind the people — the glass is
 *                sliced in half, the feet skate.
 *   farInside    far pixels taken IN to the cutout. People at the back
 *                of a room are drawn as foreground, so they slide across
 *                the table that is actually in front of them.
 *
 * Both are fractions of the frame, 0..1.
 */
function layerAgreement(
  depth: HTMLImageElement,
  cutout: HTMLImageElement,
): { nearOutside: number; farInside: number } {
  const clean = { nearOutside: 0, farInside: 0 }
  try {
    const W = 128
    const H = Math.max(1, Math.round((cutout.naturalHeight / cutout.naturalWidth) * W))
    const read = (img: HTMLImageElement) => {
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const g = c.getContext('2d', { willReadFrequently: true })
      if (!g) return null
      g.drawImage(img, 0, 0, W, H)
      return g.getImageData(0, 0, W, H).data
    }
    const d = read(depth)
    const m = read(cutout)
    if (!d || !m) return clean

    const inside: number[] = []
    const outside: number[] = []
    for (let i = 0; i < W * H; i++) (m[i * 4 + 3]! > 160 ? inside : outside).push(d[i * 4]!)
    // Too little of either to judge: say nothing rather than guess.
    if (inside.length < 64 || outside.length < 64) return clean

    inside.sort((a, b) => a - b)
    // The subject's own depth is the middle of what the cutout claims.
    const subj = inside[Math.floor(inside.length / 2)]!
    return {
      farInside: inside.filter((v) => v < subj - AGREE_MARGIN * 1.6).length / inside.length,
      nearOutside: outside.filter((v) => v >= subj - AGREE_MARGIN * 0.3).length / (W * H),
    }
  } catch {
    return clean
  }
}

/** Depth-map units (0..255) that count as a different plane. */
const AGREE_MARGIN = 38

/**
 * Thresholds, measured on the live album of 137 layered photos. Both
 * distributions sit near zero with a clear tail; these cut the tail.
 * Checked by eye at the extremes: the worst nearOutside is a car selfie
 * with coffee cups held to the lens, the worst farInside a photo with a
 * person seated behind a table. Those are the two failures reported.
 */
const MAX_NEAR_OUTSIDE = 0.05
const MAX_FAR_INSIDE = 0.08

/**
 * A tiny copy of the photo. Stretched across the stage with smoothing it
 * becomes a soft blur for almost nothing, where a real blur filter over
 * a full-screen canvas every frame is expensive enough to drop frames.
 */
function makeBackdrop(img: HTMLImageElement): HTMLCanvasElement | null {
  try {
    const c = document.createElement('canvas')
    c.width = 64
    c.height = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * 64))
    const g = c.getContext('2d')
    if (!g) return null
    g.drawImage(img, 0, 0, c.width, c.height)
    return c
  } catch {
    return null
  }
}

interface Layer {
  photo: HTMLImageElement
  /** A thumbnail-sized copy, stretched to make the blurred backdrop. */
  backdrop: HTMLCanvasElement | null
  plate: HTMLImageElement | null
  cutout: HTMLImageElement | null
  aim: { x: number; y: number }
  startedAt: number
  move: Move
  src: string
}

export default function CinematicPhoto({
  src, plateSrc, cutoutSrc, depthSrc, depthStrength = 1, camera = 'pan',
  blurTransition = true, fill = true, durationMs, className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const curRef = useRef<Layer | null>(null)
  const prevRef = useRef<Layer | null>(null)
  const fadeFromRef = useRef(0)
  /** Scratch canvas the incoming photo is composited on before it fades. */
  const offRef = useRef<HTMLCanvasElement | null>(null)

  // Read by the render loop without restarting it.
  const durationRef = useRef(durationMs)
  const strengthRef = useRef(depthStrength)
  const cameraRef = useRef(camera)
  const blurRef = useRef(blurTransition)
  const fillRef = useRef(fill)
  cameraRef.current = camera
  blurRef.current = blurTransition
  fillRef.current = fill
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
      g: CanvasRenderingContext2D,
      img: HTMLImageElement, aim: { x: number; y: number }, zoom: number,
      panX: number, panY: number, nudgeX: number, nudgeY: number,
      w: number, h: number, alpha: number,
    ) => {
      const scale = fitScale(img, w, h) * zoom
      const iw = img.naturalWidth * scale
      const ih = img.naturalHeight * scale
      const x = place(iw, w, w / 2 - aim.x * iw, panX, nudgeX)
      const y = place(ih, h, h / 2 - aim.y * ih, panY, nudgeY)
      g.globalAlpha = alpha
      g.drawImage(img, x, y, iw, ih)
      g.globalAlpha = 1
    }

    const drawLayer = (
      g: CanvasRenderingContext2D,
      layer: Layer, now: number, w: number, h: number, alpha: number,
    ) => {
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

      /*
       * The blurred backdrop, painted HERE rather than as a separate
       * image behind the canvas.
       *
       * It used to be its own DOM element keyed on the current photo, so
       * it swapped the instant a slide changed — while this canvas was
       * still fetching the new photo's layers. For that gap the NEW
       * backdrop sat behind the OLD photo, which is the "previous one is
       * still showing" and the flicker. Painted as part of the layer it
       * is captured by the offscreen composite and dissolves on the same
       * clock as the photo in front of it.
       */
      if (fillRef.current && layer.backdrop) {
        const b = layer.backdrop
        const cover = Math.max(w / b.width, h / b.height) * 1.15
        const bw = b.width * cover
        const bh = b.height * cover
        g.save()
        g.imageSmoothingEnabled = true
        g.imageSmoothingQuality = 'high'
        g.globalAlpha = alpha
        g.drawImage(b, (w - bw) / 2, (h - bh) / 2, bw, bh)
        g.fillStyle = 'rgba(0,0,0,.45)'
        g.fillRect(0, 0, w, h)
        g.restore()
      }

      /*
       * No working depth — no layers, a plate that failed a check, or
       * separation turned down to nothing — means no movement at all.
       *
       * This used to fall back to drifting the whole photograph, which
       * is exactly what the effect is not: the pan exists only to show
       * the background sliding past the people, and without that it is
       * just a picture sliding across the screen for no reason.
       */
      if (!layered) {
        drawImage(g, layer.photo, layer.aim, 1, 0, 0, 0, 0, w, h, alpha)
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

      g.save()
      g.beginPath()
      g.rect(wx, wy, iw, ih)
      g.clip()

      // Spare is what the background has to travel within. Depth
      // strength scales how much of it a slide actually uses, so 0 is a
      // still photograph and 1 the tuned default.
      // 0.97 rather than 1: at full travel the background lands exactly
      // on the window edge, and sub-pixel rounding there can flash a
      // hairline seam. The margin costs nothing visible.
      const travel = Math.min(1, strength) * 0.97
      const spareX = (iw * (PLATE_OVERSCAN - 1)) / 2
      const spareY = (ih * (PLATE_OVERSCAN - 1)) / 2
      g.globalAlpha = alpha
      g.drawImage(
        layer.plate!,
        wx - spareX + panX * travel * spareX,
        wy - spareY + panY * travel * spareY,
        iw * PLATE_OVERSCAN,
        ih * PLATE_OVERSCAN,
      )
      // The people, exactly where the window puts them, every frame.
      g.drawImage(layer.cutout!, wx, wy, iw, ih)
      g.globalAlpha = 1
      g.restore()
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

      if (!prev || f >= 1) {
        drawLayer(ctx, cur, now, w, h, 1)
        if (prev && f >= 1) prevRef.current = null
        return
      }

      /*
       * The outgoing photo at full strength, then the incoming one
       * dissolved over it AS A SINGLE IMAGE.
       *
       * Drawing the incoming plate and cutout straight onto the stage
       * at a part alpha made them translucent against each other as
       * well as against the outgoing photo, so the people ghosted over
       * their own background for the whole transition. It showed worst
       * on selfies, where the cutout covers most of the frame. Building
       * the incoming photo offscreen first and compositing it once
       * fixes that: two layers go in, one opaque image comes out.
       */
      drawLayer(ctx, prev, now, w, h, 1)

      const off = offRef.current ?? (offRef.current = document.createElement('canvas'))
      if (off.width !== w || off.height !== h) {
        off.width = w
        off.height = h
      }
      const offCtx = off.getContext('2d')
      if (!offCtx) return
      offCtx.clearRect(0, 0, w, h)
      drawLayer(offCtx, cur, now, w, h, 1)

      ctx.save()
      ctx.globalAlpha = f
      // Arrives soft and resolves, which hides the moment the pixels
      // swap. `filter` is ignored where unsupported, leaving a plain
      // dissolve rather than a broken one.
      if (blurRef.current) ctx.filter = `blur(${((1 - f) * BLUR_MAX_PX).toFixed(2)}px)`
      ctx.drawImage(off, 0, 0)
      ctx.restore()
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
      const [photo, plate, cutout, depth] = await Promise.all([
        loadImage(src),
        plateSrc ? loadImage(plateSrc) : Promise.resolve(null),
        cutoutSrc ? loadImage(cutoutSrc) : Promise.resolve(null),
        depthSrc ? loadImage(depthSrc) : Promise.resolve(null),
      ])
      if (cancelled || !photo) return

      // Parallax is only trusted when every check passes. Any failure
      // and the photo is shown still — a still photograph looks like a
      // photograph, where a bad separation looks broken.
      //   - the plate must actually have had the people removed
      //   - the cutout must agree with the depth map, when there is one
      const agree = depth && cutout ? layerAgreement(depth, cutout) : null
      const usable = Boolean(
        plate && cutout
        && plateChange(photo, plate, cutout) >= PLATE_MIN_CHANGE
        && (!agree || (agree.nearOutside <= MAX_NEAR_OUTSIDE && agree.farInside <= MAX_FAR_INSIDE)),
      )

      curRef.current && (prevRef.current = curRef.current)
      curRef.current = {
        photo,
        backdrop: makeBackdrop(photo),
        plate: usable ? plate : null,
        cutout: usable ? cutout : null,
        aim: cutout ? aimFromCutout(cutout) : { x: 0.5, y: 0.42 },
        startedAt: performance.now(),
        move: moveWith(moveFor(src), cameraRef.current),
        src,
      }
      fadeFromRef.current = performance.now()
    })()
    return () => { cancelled = true }
  }, [src, plateSrc, cutoutSrc, depthSrc])

  return <canvas ref={canvasRef} className={className} />
}
