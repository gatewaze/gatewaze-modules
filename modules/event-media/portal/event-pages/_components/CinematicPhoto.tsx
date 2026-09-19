'use client'

// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * Cinematic photo renderer — the "video showroom" layer.
 *
 * Draws one photo into a transparent WebGL canvas with:
 *  - 2.5D depth parallax: the monocular depth map displaces sampling
 *    UVs against a slow camera drift, so foreground subjects move
 *    against their background. Stills read as motion footage.
 *  - Subject pop: the alpha matte fades the BACKGROUND of the photo to
 *    transparent mid-slide, revealing the blurred cover-fill layer
 *    behind it — the background appears to melt away and the people
 *    float forward. This is the "background removed by animation".
 *  - Subject-aware framing: zoom/drift centre on the matte centroid,
 *    so the camera moves toward people rather than drifting blindly.
 *
 * Degrades cleanly at every step: no WebGL → caller falls back to the
 * CSS effects; no depth → flat pan/zoom; no matte → no pop. The
 * canvas is transparent so the blurred fill behind always shows.
 */

import { useEffect, useRef } from 'react'
import type { PhotoAnalysis } from './_lib/ai-pipeline'

interface Props {
  src: string
  analysis: PhotoAnalysis | null
  /** Slide duration; the pop cycle is timed against it. */
  durationMs: number
  /** Disable the background-melt half of the effect. */
  enablePop?: boolean
  className?: string
}

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
    // floor. A imperfect mask then reads as a soft vignette toward the
    // blurred fill behind, instead of a hole punched in the photo.
    alpha = 1.0 - uPop * (1.0 - m) * (1.0 - uBgFloor);
  }

  gl_FragColor = vec4(rgb, alpha);
}`

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
 * A projector is 1920 wide, so 2048 loses nothing visible.
 */
function fitForGpu(gl: WebGLRenderingContext, img: HTMLImageElement): TexImageSource {
  const maxGpu = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048, 2048)
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

export default function CinematicPhoto({ src, analysis, durationMs, enablePop = true, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const glRef = useRef<WebGLRenderingContext | null>(null)

  // Release the GPU context ONLY when the component goes away. It must
  // not happen in the per-photo cleanup: a lost context can never be
  // re-acquired from the same canvas, so doing it there left every
  // slide after the first one blank (caught in the harness
  // 2026-09-20 — the effect re-runs the moment analysis arrives).
  useEffect(() => {
    return () => {
      glRef.current?.getExtension('WEBGL_lose_context')?.loseContext()
      glRef.current = null
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let disposed = false
    let gl: WebGLRenderingContext | null = null
    const textures: WebGLTexture[] = []
    let program: WebGLProgram | null = null
    let buffer: WebGLBuffer | null = null

    const start = async () => {
      // The photo must be CORS-clean or texImage2D throws (storage and
      // render endpoints both send ACAO:*, verified 2026-09-20).
      const img = await new Promise<HTMLImageElement | null>((resolve) => {
        const i = new window.Image()
        i.crossOrigin = 'anonymous'
        i.onload = () => resolve(i)
        i.onerror = () => resolve(null)
        i.src = src
      })
      if (disposed || !img) return

      // Reuse the context across photos — see the unmount effect above.
      gl = glRef.current
      if (!gl || gl.isContextLost()) {
        gl = (canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: true }) ??
          canvas.getContext('experimental-webgl', { alpha: true })) as WebGLRenderingContext | null
        glRef.current = gl
      }
      if (!gl) return

      const vs = compile(gl, gl.VERTEX_SHADER, VERT)
      const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
      if (!vs || !fs) return
      const prog = gl.createProgram()
      if (!prog) return
      program = prog
      gl.attachShader(prog, vs)
      gl.attachShader(prog, fs)
      gl.linkProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return
      gl.useProgram(prog)

      const buf = gl.createBuffer()
      buffer = buf
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
      const aPos = gl.getAttribLocation(prog, 'aPos')
      gl.enableVertexAttribArray(aPos)
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

      const photoTex = makeTexture(gl, fitForGpu(gl, img))
      const depthTex = makeTexture(gl, analysis?.depth ?? null)
      const matteTex = makeTexture(gl, analysis?.matte ?? null)
      if (!photoTex) return
      textures.push(photoTex)
      if (depthTex) textures.push(depthTex)
      if (matteTex) textures.push(matteTex)

      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, photoTex)
      gl.uniform1i(gl.getUniformLocation(prog, 'uPhoto'), 0)
      if (depthTex) {
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, depthTex)
        gl.uniform1i(gl.getUniformLocation(prog, 'uDepth'), 1)
      }
      if (matteTex) {
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, matteTex)
        gl.uniform1i(gl.getUniformLocation(prog, 'uMatte'), 2)
      }

      const uContain = gl.getUniformLocation(prog, 'uContain')
      const uCam = gl.getUniformLocation(prog, 'uCam')
      const uFocus = gl.getUniformLocation(prog, 'uFocus')
      const uParallax = gl.getUniformLocation(prog, 'uParallax')
      const uZoom = gl.getUniformLocation(prog, 'uZoom')
      const uPop = gl.getUniformLocation(prog, 'uPop')
      // Pop only with a mask the analyser judged coherent.
      const popOk = Boolean(matteTex && enablePop && analysis && analysis.popSafe)
      gl.uniform1f(gl.getUniformLocation(prog, 'uHasDepth'), depthTex ? 1 : 0)
      gl.uniform1f(gl.getUniformLocation(prog, 'uHasMatte'), popOk ? 1 : 0)
      gl.uniform1f(gl.getUniformLocation(prog, 'uBgFloor'), 0.28)
      gl.uniform1f(uParallax, depthTex ? 0.055 : 0)

      // Aim at the subject; fall back to slightly above centre, which
      // is where faces sit in most group photos.
      const focus = analysis?.subject ?? { x: 0.5, y: 0.42 }
      gl.uniform2f(uFocus, focus.x, focus.y)

      gl.enable(gl.BLEND)
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.clearColor(0, 0, 0, 0)

      const t0 = performance.now()
      const duration = Math.max(durationMs, 2000)

      const frame = (now: number) => {
        if (disposed || !gl) return
        const w = canvas.clientWidth || 1920
        const h = canvas.clientHeight || 1080
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w
          canvas.height = h
        }
        gl.viewport(0, 0, canvas.width, canvas.height)

        // Contain mapping: stage aspect vs photo aspect.
        const stageAR = w / h
        const photoAR = img.naturalWidth / img.naturalHeight
        const cx = photoAR > stageAR ? 1 : stageAR / photoAR
        const cy = photoAR > stageAR ? photoAR / stageAR : 1
        gl.uniform2f(uContain, cx, cy)

        const t = (now - t0) / duration // 0..1 across the slide
        // Lissajous drift — never repeats exactly, never snaps.
        const drift = Math.min(1, t * 4) // ease in over the first quarter
        gl.uniform2f(
          uCam,
          Math.sin(t * Math.PI * 1.1) * drift,
          Math.cos(t * Math.PI * 0.7) * 0.6 * drift,
        )
        // Slow push-in across the whole slide.
        gl.uniform1f(uZoom, 1.0 + Math.min(t, 1) * 0.06)

        // Background melt: hold, ease in, hold, ease back out.
        let pop = 0
        if (enablePop && matteTex) {
          if (t > 0.32 && t <= 0.5) pop = (t - 0.32) / 0.18
          else if (t > 0.5 && t <= 0.78) pop = 1
          else if (t > 0.78 && t <= 0.92) pop = 1 - (t - 0.78) / 0.14
          pop = Math.max(0, Math.min(1, pop))
          pop = pop * pop * (3 - 2 * pop) // smoothstep
        }
        gl.uniform1f(uPop, pop)

        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        rafRef.current = requestAnimationFrame(frame)
      }
      rafRef.current = requestAnimationFrame(frame)
    }

    void start()

    return () => {
      disposed = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      // Free this photo's GPU resources but KEEP the context alive —
      // a projector runs for hours, so the per-photo allocations must
      // be released, while the context is reused for the next slide.
      if (gl) {
        for (const t of textures) gl.deleteTexture(t)
        if (buffer) gl.deleteBuffer(buffer)
        if (program) gl.deleteProgram(program)
      }
    }
  }, [src, analysis, durationMs, enablePop])

  return <canvas ref={canvasRef} className={className} />
}
