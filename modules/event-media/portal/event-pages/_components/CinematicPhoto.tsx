'use client'

// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * Cinematic photo renderer — the "video showroom" layer.
 *
 * Draws photos into a transparent WebGL canvas with:
 *  - 2.5D depth parallax: the monocular depth map displaces sampling
 *    UVs against a slow camera drift, so foreground subjects move
 *    against their background. Stills read as motion footage.
 *  - Subject pop: the alpha matte fades the BACKGROUND of the photo to
 *    transparent mid-slide, revealing the blurred cover-fill layer
 *    behind it — the background appears to melt away and the people
 *    float forward.
 *  - Subject-aware framing: zoom/drift centre on the matte centroid,
 *    so the camera moves toward people rather than drifting blindly.
 *
 * The component OWNS THE WHOLE SLIDESHOW, not one photo. That is
 * deliberate and was a bug fix (2026-09-20): it used to be remounted
 * per slide with a React key, which destroyed the canvas, took a fresh
 * WebGL context every slide, and left the photo layer empty until the
 * next original had downloaded — measured at 265-546 ms on a fast
 * connection and up to 9.1 s on venue wifi. For that whole window the
 * only thing on screen was the blurred, 1.15x-scaled cover fill, which
 * read as the photo "jumping" to a zoomed-in blurry copy of itself.
 *
 * So instead: one context for the life of the display, the outgoing
 * photo stays on screen until the incoming one is decoded and uploaded
 * to the GPU, and the two cross-dissolve. Nothing is ever blank.
 *
 * Degrades cleanly at every step: no WebGL → caller falls back to the
 * CSS effects; no depth → flat pan/zoom; no matte → no pop. The canvas
 * is transparent so the blurred fill behind always shows.
 */

import { useEffect, useRef } from 'react'
import type { PhotoAnalysis } from './_lib/ai-pipeline'

interface Props {
  /** Current photo. Changing this cross-fades to the new one. */
  src: string
  analysis: PhotoAnalysis | null
  /** Slide duration; the pop cycle is timed against it. */
  durationMs: number
  /** Disable the background-melt half of the effect. */
  enablePop?: boolean
  className?: string
}

const FADE_MS = 900

/**
 * Camera moves, in the Ken Burns sense: a slow zoom combined with a
 * pan. Pan is expressed as a FRACTION OF THE SLACK the zoom creates
 * (±1 = right to the edge), so a move can never sample past the edge
 * of the photo whatever the zoom is.
 *
 * The amounts are deliberately much larger than the original effect's:
 * that pushed in 6% over a whole slide and displaced by under 3%, which
 * is invisible across a room. These run 8-26%.
 */
interface Move { z0: number; z1: number; x0: number; y0: number; x1: number; y1: number }

const MOVES: Move[] = [
  { z0: 1.08, z1: 1.26, x0: 0, y0: 0, x1: 0, y1: 0 },              // push in
  { z0: 1.26, z1: 1.08, x0: 0, y0: 0, x1: 0, y1: 0 },              // pull back
  { z0: 1.16, z1: 1.22, x0: -0.85, y0: 0, x1: 0.85, y1: 0 },       // pan right
  { z0: 1.22, z1: 1.16, x0: 0.85, y0: 0, x1: -0.85, y1: 0 },       // pan left
  { z0: 1.10, z1: 1.24, x0: -0.7, y0: 0.7, x1: 0.5, y1: -0.5 },    // dive in, diagonal
  { z0: 1.24, z1: 1.10, x0: 0.6, y0: -0.6, x1: -0.4, y1: 0.4 },    // rise out, diagonal
  { z0: 1.12, z1: 1.28, x0: 0.5, y0: 0.6, x1: -0.2, y1: -0.3 },    // push in from low
  { z0: 1.20, z1: 1.14, x0: 0, y0: -0.8, x1: 0, y1: 0.8 },         // tilt down
]

/** Same photo always gets the same move, different photos differ. */
function moveFor(src: string): Move {
  let h = 0
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) | 0
  return MOVES[Math.abs(h) % MOVES.length]!
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uPhoto;
uniform sampler2D uDepth;
uniform sampler2D uMatte;
uniform vec2  uContain;   // vUv -> photo uv (letterboxed fit)
uniform vec2  uCam;       // camera drift, roughly -1..1
uniform vec2  uFocus;     // subject centroid in photo uv
uniform float uParallax;  // displacement strength
uniform float uZoom;      // >1 pushes in
uniform float uPop;       // 0..1 background melt
uniform float uBgFloor;   // how far the background is allowed to fade
uniform float uHasDepth;
uniform float uHasMatte;
uniform float uOpacity;   // cross-dissolve weight for this layer

void main() {
  // Map the stage pixel into the photo's contained rect.
  vec2 uv = (vUv - 0.5) * uContain + 0.5;

  // Outside the photo rect: fully transparent, so the blurred cover
  // layer behind shows through as the letterbox fill.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // Push in around the subject, not the geometric centre.
  vec2 zuv = (uv - uFocus) / uZoom + uFocus;

  // Subject scales fractionally more than the frame during the pop.
  vec2 suv = (zuv - uFocus) / (1.0 + uPop * 0.05) + uFocus;

  float d = uHasDepth > 0.5 ? texture2D(uDepth, suv).r : 0.5;
  // Near (bright depth) displaces most — that is the parallax.
  vec2 puv = suv + (d - 0.5) * uParallax * uCam;
  puv = clamp(puv, vec2(0.0), vec2(1.0));

  vec3 rgb = texture2D(uPhoto, puv).rgb;

  float alpha = 1.0;
  if (uHasMatte > 0.5) {
    float m = texture2D(uMatte, suv).a;
    // Soften the matte edge so the melt never looks cut out.
    m = smoothstep(0.35, 0.75, m);
    // The background never goes fully transparent: it recedes to a
    // floor. An imperfect mask then reads as a soft vignette toward the
    // blurred fill behind, instead of a hole punched in the photo.
    alpha = 1.0 - uPop * (1.0 - m) * (1.0 - uBgFloor);
  }

  gl_FragColor = vec4(rgb, alpha * uOpacity);
}`

interface Layer {
  photo: WebGLTexture
  depth: WebGLTexture | null
  matte: WebGLTexture | null
  /** Natural aspect ratio of the source photo. */
  ar: number
  focus: { x: number; y: number }
  popSafe: boolean
  /** Clock origin for this layer's own pan/zoom/pop cycle. */
  startedAt: number
  /** The camera move this photo was dealt. */
  move: Move
  src: string
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, source)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh)
    return null
  }
  return sh
}

/**
 * Downscale to something every GPU can hold. Guest phones produce
 * 24 MP files (4284x5712 seen live) — above MAX_TEXTURE_SIZE on plenty
 * of laptop GPUs, where texImage2D fails and the slide renders black.
 */
function fitForGpu(gl: WebGLRenderingContext, img: HTMLImageElement): TexImageSource {
  const maxGpu = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048, 4096)
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight)
  if (longEdge <= maxGpu) return img
  const scale = maxGpu / longEdge
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return img
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas
}

function makeTexture(gl: WebGLRenderingContext, source: TexImageSource | null): WebGLTexture | null {
  if (!source) return null
  const tex = gl.createTexture()
  if (!tex) return null
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource)
  } catch {
    gl.deleteTexture(tex)
    return null
  }
  return tex
}

/**
 * Attach depth/matte to a layer in place. Never rebuilds the layer:
 * that would reset its clock and snap the zoom back mid-slide, which is
 * what the old single effect did whenever analysis arrived late.
 */
function applyAnalysis(gl: WebGLRenderingContext, layer: Layer, analysis: PhotoAnalysis | null): void {
  if (!analysis) return
  if (analysis.depth && !layer.depth) layer.depth = makeTexture(gl, analysis.depth)
  if (analysis.matte && !layer.matte) layer.matte = makeTexture(gl, analysis.matte)
  if (analysis.subject) layer.focus = analysis.subject
  layer.popSafe = Boolean(analysis.popSafe)
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    // The photo must be CORS-clean or texImage2D throws (storage and
    // render endpoints both send ACAO:*, verified 2026-09-20).
    const i = new window.Image()
    i.crossOrigin = 'anonymous'
    i.onload = () => resolve(i)
    i.onerror = () => resolve(null)
    i.src = src
  })
}

export default function CinematicPhoto({ src, analysis, durationMs, enablePop = true, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const glRef = useRef<WebGLRenderingContext | null>(null)
  const progRef = useRef<WebGLProgram | null>(null)
  const bufRef = useRef<WebGLBuffer | null>(null)
  const rafRef = useRef<number | null>(null)

  const curRef = useRef<Layer | null>(null)
  const prevRef = useRef<Layer | null>(null)
  const fadeFromRef = useRef(0)

  // Props the render loop reads without wanting to restart on change.
  const durationRef = useRef(durationMs)
  const popRef = useRef(enablePop)
  // The photo loads asynchronously, so by the time a layer exists the
  // analysis for it may ALREADY have arrived and its effect long since
  // run. Without this the photo would keep a flat pan for its whole
  // slide despite having a depth map ready.
  const analysisRef = useRef<PhotoAnalysis | null>(analysis)
  durationRef.current = durationMs
  popRef.current = enablePop
  analysisRef.current = analysis

  // ── One context, one program, one loop, for the whole display ─────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let disposed = false

    const gl = (canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: true }) ??
      canvas.getContext('experimental-webgl', { alpha: true })) as WebGLRenderingContext | null
    if (!gl) return
    glRef.current = gl

    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    if (!vs || !fs) return
    const prog = gl.createProgram()
    if (!prog) return
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return
    gl.useProgram(prog)
    progRef.current = prog

    const buf = gl.createBuffer()
    bufRef.current = buf
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    const u = {
      contain: gl.getUniformLocation(prog, 'uContain'),
      cam: gl.getUniformLocation(prog, 'uCam'),
      focus: gl.getUniformLocation(prog, 'uFocus'),
      parallax: gl.getUniformLocation(prog, 'uParallax'),
      zoom: gl.getUniformLocation(prog, 'uZoom'),
      pop: gl.getUniformLocation(prog, 'uPop'),
      bgFloor: gl.getUniformLocation(prog, 'uBgFloor'),
      hasDepth: gl.getUniformLocation(prog, 'uHasDepth'),
      hasMatte: gl.getUniformLocation(prog, 'uHasMatte'),
      opacity: gl.getUniformLocation(prog, 'uOpacity'),
      photo: gl.getUniformLocation(prog, 'uPhoto'),
      depth: gl.getUniformLocation(prog, 'uDepth'),
      matte: gl.getUniformLocation(prog, 'uMatte'),
    }

    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)

    const drawLayer = (layer: Layer, now: number, stageAR: number, opacity: number) => {
      // Contain mapping: stage aspect vs photo aspect.
      const cx = layer.ar > stageAR ? 1 : stageAR / layer.ar
      const cy = layer.ar > stageAR ? layer.ar / stageAR : 1
      gl.uniform2f(u.contain, cx, cy)

      const t = (now - layer.startedAt) / Math.max(durationRef.current, 2000)
      // Linear, like a real camera move — easing makes the middle rush.
      // Clamped so a slide held open does not drift forever.
      const k = Math.max(0, Math.min(1, t))
      const m = layer.move
      const zoom = lerp(m.z0, m.z1, k)
      // How far the centre can move before the window leaves the photo.
      const slack = Math.max(0, (1 - 1 / zoom) / 2)
      gl.uniform1f(u.zoom, zoom)
      gl.uniform2f(
        u.focus,
        0.5 + lerp(m.x0, m.x1, k) * slack,
        0.5 + lerp(m.y0, m.y1, k) * slack,
      )
      // Parallax rides the move; zero without a depth map.
      gl.uniform2f(u.cam, Math.sin(k * Math.PI), Math.cos(k * Math.PI) * 0.6)
      gl.uniform1f(u.parallax, layer.depth ? 0.055 : 0)
      gl.uniform1f(u.bgFloor, 0.28)
      gl.uniform1f(u.hasDepth, layer.depth ? 1 : 0)

      const popOk = Boolean(layer.matte && popRef.current && layer.popSafe)
      gl.uniform1f(u.hasMatte, popOk ? 1 : 0)

      // Background melt: hold, ease in, hold, ease back out.
      let pop = 0
      if (popOk) {
        if (t > 0.32 && t <= 0.5) pop = (t - 0.32) / 0.18
        else if (t > 0.5 && t <= 0.78) pop = 1
        else if (t > 0.78 && t <= 0.92) pop = 1 - (t - 0.78) / 0.14
        pop = Math.max(0, Math.min(1, pop))
        pop = pop * pop * (3 - 2 * pop) // smoothstep
      }
      gl.uniform1f(u.pop, pop)
      gl.uniform1f(u.opacity, opacity)

      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, layer.photo)
      gl.uniform1i(u.photo, 0)
      if (layer.depth) {
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, layer.depth)
        gl.uniform1i(u.depth, 1)
      }
      if (layer.matte) {
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, layer.matte)
        gl.uniform1i(u.matte, 2)
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    const frame = (now: number) => {
      if (disposed) return
      rafRef.current = requestAnimationFrame(frame)
      const cur = curRef.current
      if (!cur) return

      // Render at the display's real pixels: without the ratio the
      // canvas is half resolution on a 2x screen and every cinematic
      // slide looks soft next to the plain-<img> effects.
      //
      // Measure the PARENT and pin the canvas's CSS size from it. Sizing
      // the backing store from the canvas's own clientWidth is a
      // feedback loop — the new backing store becomes the element's
      // intrinsic size, so at dpr 2 it doubles every frame until it
      // explodes (caught in the harness at 67 megapixels).
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
      gl.viewport(0, 0, canvas.width, canvas.height)
      const stageAR = w / h

      gl.clear(gl.COLOR_BUFFER_BIT)

      const prev = prevRef.current
      const f = prev ? Math.min(1, (now - fadeFromRef.current) / FADE_MS) : 1
      // The outgoing photo is drawn at full strength and the incoming
      // one dissolves over it, so the blurred fill behind never shows
      // through mid-transition.
      if (prev && f < 1) drawLayer(prev, now, stageAR, 1)
      drawLayer(cur, now, stageAR, f)

      if (prev && f >= 1) {
        gl.deleteTexture(prev.photo)
        if (prev.depth) gl.deleteTexture(prev.depth)
        if (prev.matte) gl.deleteTexture(prev.matte)
        prevRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(frame)

    return () => {
      disposed = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      for (const l of [curRef.current, prevRef.current]) {
        if (!l) continue
        gl.deleteTexture(l.photo)
        if (l.depth) gl.deleteTexture(l.depth)
        if (l.matte) gl.deleteTexture(l.matte)
      }
      curRef.current = null
      prevRef.current = null
      if (bufRef.current) gl.deleteBuffer(bufRef.current)
      if (progRef.current) gl.deleteProgram(progRef.current)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      glRef.current = null
    }
  }, [])

  // ── Swap in a new photo, once it is actually ready ────────────────
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const img = await loadImage(src)
      const gl = glRef.current
      // Nothing is torn down on failure: the photo already on screen
      // simply stays until the next one arrives.
      if (cancelled || !img || !gl) return
      const photo = makeTexture(gl, fitForGpu(gl, img))
      if (!photo) return

      const incoming: Layer = {
        photo,
        depth: null,
        matte: null,
        ar: img.naturalWidth / img.naturalHeight,
        // Aim at the subject; fall back to slightly above centre, which
        // is where faces sit in most group photos.
        focus: { x: 0.5, y: 0.42 },
        popSafe: false,
        startedAt: performance.now(),
        move: moveFor(src),
        src,
      }

      // Retire whatever the previous transition left behind, so a run
      // of fast slide changes cannot stack up textures.
      const stale = prevRef.current
      if (stale) {
        gl.deleteTexture(stale.photo)
        if (stale.depth) gl.deleteTexture(stale.depth)
        if (stale.matte) gl.deleteTexture(stale.matte)
      }
      applyAnalysis(gl, incoming, analysisRef.current)
      prevRef.current = curRef.current
      curRef.current = incoming
      fadeFromRef.current = performance.now()
    })()
    return () => { cancelled = true }
  }, [src])

  // ── Upgrade the current photo when its analysis lands late ────────
  useEffect(() => {
    const gl = glRef.current
    const cur = curRef.current
    if (!gl || !cur || cur.src !== src) return
    applyAnalysis(gl, cur, analysis)
  }, [analysis, src])

  return <canvas ref={canvasRef} className={className} />
}
