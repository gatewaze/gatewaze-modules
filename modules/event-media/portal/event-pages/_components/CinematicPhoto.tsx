'use client'

// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * Cinematic photo renderer — the "3D photo" layer.
 *
 * Each photo is drawn as a shallow relief rather than a flat picture,
 * using a cached depth map:
 *
 *  - parallax occlusion: the view ray is walked through the depth
 *    field, so as the camera drifts, near subjects genuinely move
 *    against — and cover — what is behind them
 *  - depth of field: distance from the focus plane defocuses, which is
 *    what actually convinces the eye there is volume
 *  - aerial perspective: far pixels lose colour and sit back
 *
 * The depth map is FETCHED, not computed. Depth is a property of the
 * photo, so the API generates it once on upload and caches it beside
 * the image. The previous version ran two ML models in the browser for
 * every photo, on the main thread, and froze the display for seconds
 * at a time (p95 frame gap 3.9 s against 0.2 s for Ken Burns, measured
 * 2026-09-20). Sampling a texture costs nothing.
 *
 * The component OWNS THE WHOLE SLIDESHOW, not one photo — it used to
 * be remounted per slide with a React key, which destroyed the canvas
 * every slide and left the screen on the blurred fill until the next
 * image downloaded. One context, and the outgoing photo holds the
 * screen until the incoming one is ready to cross-dissolve.
 *
 * Degrades cleanly: no WebGL → the caller falls back to CSS effects;
 * no depth map → a plain camera move, no relief. The canvas is
 * transparent, so the blurred fill behind always shows.
 */

import { useEffect, useRef } from 'react'

interface Props {
  /** Current photo. Changing this cross-fades to the new one. */
  src: string
  /** Cached depth map for `src`, near = white. Absent → flat move. */
  depthSrc?: string | null
  /** 0 disables the relief entirely; 1 is the tuned default. */
  depthStrength?: number
  /** Slide duration; the camera move is timed against it. */
  durationMs: number
  className?: string
}

const FADE_MS = 900

/** Tuned against real photos; `depthStrength` scales all three. */
const PARALLAX = 0.055
const DOF = 3.0
const AERIAL = 0.5
/** Depth held sharp. Near is 1.0, so this keeps faces crisp. */
const FOCUS_PLANE = 0.82

/**
 * Camera moves, in the Ken Burns sense: a slow zoom combined with a
 * pan. Pan is a FRACTION OF THE SLACK the zoom creates (±1 = right to
 * the edge), so a move can never sample past the edge of the photo.
 * The pan also drives the parallax, so the relief tracks the motion.
 */
interface Move { z0: number; z1: number; x0: number; y0: number; x1: number; y1: number }

const MOVES: Move[] = [
  { z0: 1.08, z1: 1.26, x0: 0, y0: 0, x1: 0, y1: 0 },
  { z0: 1.26, z1: 1.08, x0: 0, y0: 0, x1: 0, y1: 0 },
  { z0: 1.16, z1: 1.22, x0: -0.85, y0: 0, x1: 0.85, y1: 0 },
  { z0: 1.22, z1: 1.16, x0: 0.85, y0: 0, x1: -0.85, y1: 0 },
  { z0: 1.10, z1: 1.24, x0: -0.7, y0: 0.7, x1: 0.5, y1: -0.5 },
  { z0: 1.24, z1: 1.10, x0: 0.6, y0: -0.6, x1: -0.4, y1: 0.4 },
  { z0: 1.12, z1: 1.28, x0: 0.5, y0: 0.6, x1: -0.2, y1: -0.3 },
  { z0: 1.20, z1: 1.14, x0: 0, y0: -0.8, x1: 0, y1: 0.8 },
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
uniform vec2  uContain;    // vUv -> photo uv (letterboxed fit)
uniform vec2  uPan;        // frame offset in photo uv
uniform vec2  uCam;        // camera direction driving the parallax
uniform vec2  uTexel;      // one photo pixel, for the defocus taps
uniform float uZoom;
uniform float uParallax;
uniform float uDof;
uniform float uAerial;
uniform float uFocusPlane;
uniform float uHasDepth;
uniform float uOpacity;

float depthAt(vec2 p) { return texture2D(uDepth, clamp(p, 0.0, 1.0)).r; }

void main() {
  vec2 uv = (vUv - 0.5) * uContain + 0.5;

  // Outside the photo rect: transparent, so the blurred cover layer
  // behind shows through as the letterbox fill.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // Zoom about the centre, then slide the framing.
  vec2 zuv = (uv - 0.5) / uZoom + 0.5 + uPan;

  vec2 p = zuv;
  float d = 0.5;
  if (uHasDepth > 0.5) {
    // Walk the view ray through the depth field rather than applying a
    // single flat shift: near things then cover what is behind them
    // instead of smearing into it.
    vec2 dir = uCam * uParallax;
    d = depthAt(zuv);
    p = zuv + dir * (d - 0.5);
    for (int i = 0; i < 4; i++) {
      d = depthAt(p);
      p = zuv + dir * (d - 0.5);
    }
  }

  vec3 rgb = texture2D(uPhoto, clamp(p, 0.0, 1.0)).rgb;

  if (uHasDepth > 0.5) {
    // Defocus by distance from the plane held sharp. This is what
    // actually convinces the eye the picture has volume.
    float blur = abs(d - uFocusPlane) * uDof;
    if (blur > 0.002) {
      vec3 acc = rgb;
      float w = 1.0;
      for (int i = 1; i <= 3; i++) {
        vec2 o = uTexel * blur * float(i) * 3.0;
        acc += texture2D(uPhoto, clamp(p + vec2( o.x, 0.0), 0.0, 1.0)).rgb;
        acc += texture2D(uPhoto, clamp(p + vec2(-o.x, 0.0), 0.0, 1.0)).rgb;
        acc += texture2D(uPhoto, clamp(p + vec2(0.0,  o.y), 0.0, 1.0)).rgb;
        acc += texture2D(uPhoto, clamp(p + vec2(0.0, -o.y), 0.0, 1.0)).rgb;
        w += 4.0;
      }
      rgb = acc / w;
    }

    // Aerial perspective: distance desaturates and cools.
    float far = 1.0 - d;
    float g = dot(rgb, vec3(0.299, 0.587, 0.114));
    rgb = mix(rgb, vec3(g) * vec3(0.94, 0.97, 1.05), far * uAerial);
    rgb *= 1.0 - far * uAerial * 0.30;
  }

  gl_FragColor = vec4(rgb, uOpacity);
}`

interface Layer {
  photo: WebGLTexture
  depth: WebGLTexture | null
  /** Natural aspect ratio of the source photo. */
  ar: number
  /** One photo pixel in UV, for the defocus taps. */
  texel: [number, number]
  /** Clock origin for this layer's own camera move. */
  startedAt: number
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

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    // Must be CORS-clean or texImage2D throws (storage and render
    // endpoints both send ACAO:*, verified 2026-09-20).
    const i = new window.Image()
    i.crossOrigin = 'anonymous'
    i.onload = () => resolve(i)
    i.onerror = () => resolve(null)
    i.src = src
  })
}

export default function CinematicPhoto({
  src, depthSrc, depthStrength = 1, durationMs, className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const glRef = useRef<WebGLRenderingContext | null>(null)
  const progRef = useRef<WebGLProgram | null>(null)
  const bufRef = useRef<WebGLBuffer | null>(null)
  const rafRef = useRef<number | null>(null)

  const curRef = useRef<Layer | null>(null)
  const prevRef = useRef<Layer | null>(null)
  const fadeFromRef = useRef(0)

  // Read by the render loop without restarting it.
  const durationRef = useRef(durationMs)
  const strengthRef = useRef(depthStrength)
  durationRef.current = durationMs
  strengthRef.current = depthStrength

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
      pan: gl.getUniformLocation(prog, 'uPan'),
      cam: gl.getUniformLocation(prog, 'uCam'),
      texel: gl.getUniformLocation(prog, 'uTexel'),
      zoom: gl.getUniformLocation(prog, 'uZoom'),
      parallax: gl.getUniformLocation(prog, 'uParallax'),
      dof: gl.getUniformLocation(prog, 'uDof'),
      aerial: gl.getUniformLocation(prog, 'uAerial'),
      focusPlane: gl.getUniformLocation(prog, 'uFocusPlane'),
      hasDepth: gl.getUniformLocation(prog, 'uHasDepth'),
      opacity: gl.getUniformLocation(prog, 'uOpacity'),
      photo: gl.getUniformLocation(prog, 'uPhoto'),
      depth: gl.getUniformLocation(prog, 'uDepth'),
    }

    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)

    const drawLayer = (layer: Layer, now: number, stageAR: number, opacity: number) => {
      const cx = layer.ar > stageAR ? 1 : stageAR / layer.ar
      const cy = layer.ar > stageAR ? layer.ar / stageAR : 1
      gl.uniform2f(u.contain, cx, cy)

      const t = (now - layer.startedAt) / Math.max(durationRef.current, 2000)
      // Linear, like a real camera move; easing makes the middle rush.
      const k = Math.max(0, Math.min(1, t))
      const m = layer.move
      const zoom = lerp(m.z0, m.z1, k)
      // How far the framing can slide before the window leaves the photo.
      const slack = Math.max(0, (1 - 1 / zoom) / 2)
      const panX = lerp(m.x0, m.x1, k)
      const panY = lerp(m.y0, m.y1, k)

      const strength = Math.max(0, Math.min(2, strengthRef.current))
      const hasDepth = Boolean(layer.depth) && strength > 0.001

      gl.uniform1f(u.zoom, zoom)
      gl.uniform2f(u.pan, panX * slack, panY * slack)
      // The same pan direction drives the parallax, so the relief moves
      // with the camera rather than independently of it.
      gl.uniform2f(u.cam, panX, panY)
      gl.uniform1f(u.parallax, PARALLAX * strength)
      gl.uniform1f(u.dof, DOF * strength)
      gl.uniform1f(u.aerial, AERIAL * strength)
      gl.uniform1f(u.focusPlane, FOCUS_PLANE)
      gl.uniform1f(u.hasDepth, hasDepth ? 1 : 0)
      gl.uniform2f(u.texel, layer.texel[0], layer.texel[1])
      gl.uniform1f(u.opacity, opacity)

      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, layer.photo)
      gl.uniform1i(u.photo, 0)
      if (layer.depth) {
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, layer.depth)
        gl.uniform1i(u.depth, 1)
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    const frame = (now: number) => {
      if (disposed) return
      rafRef.current = requestAnimationFrame(frame)
      const cur = curRef.current
      if (!cur) return

      // Render at the display's real pixels. Measure the PARENT and pin
      // the canvas CSS size from it: sizing the backing store from the
      // canvas's own clientWidth is a feedback loop that doubles every
      // frame at dpr 2 (caught in the harness at 67 megapixels).
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
      // Depth is optional: a missing map costs the relief, not the
      // slide, so a failed fetch must not hold the photo back.
      const [img, depthImg] = await Promise.all([
        loadImage(src),
        depthSrc ? loadImage(depthSrc) : Promise.resolve(null),
      ])
      const gl = glRef.current
      if (cancelled || !img || !gl) return
      const photo = makeTexture(gl, fitForGpu(gl, img))
      if (!photo) return

      const incoming: Layer = {
        photo,
        depth: depthImg ? makeTexture(gl, fitForGpu(gl, depthImg)) : null,
        ar: img.naturalWidth / img.naturalHeight,
        texel: [1 / Math.max(img.naturalWidth, 1), 1 / Math.max(img.naturalHeight, 1)],
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
      }
      prevRef.current = curRef.current
      curRef.current = incoming
      fadeFromRef.current = performance.now()
    })()
    return () => { cancelled = true }
  }, [src, depthSrc])

  return <canvas ref={canvasRef} className={className} />
}
