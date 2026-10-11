// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * On-device photo understanding for the projector display.
 *
 * Runs entirely in the browser on the machine driving the projector:
 * no server, no per-photo API cost, nothing for autodb to host. Two
 * analyses per photo, both cached:
 *
 *   depth  — monocular depth map, drives the 2.5D parallax shader
 *   matte  — subject alpha matte, drives subject-pop + subject-aware
 *            framing (the mask centroid is where the camera aims)
 *
 * Design rules, all learned from the live-camera layer:
 *  - NOTHING here may block a slide. Analysis is queued at concurrency
 *    1 and a photo shows immediately with its non-AI effect, upgrading
 *    only once its analysis lands.
 *  - Every failure is terminal-but-quiet: one failed load flips the
 *    whole subsystem off for the session and the display silently
 *    stays on Ken Burns. A projector must never show an error.
 *  - transformers.js is fetched at RUNTIME from a CDN via a
 *    webpackIgnore'd dynamic import, so it is not a build dependency
 *    of the module or the portal at all.
 */

export interface PhotoAnalysis {
  /** Grayscale depth map, near = white. Small (model native res). */
  depth: HTMLCanvasElement | null
  /** Subject alpha matte as a canvas (alpha channel = subject). */
  matte: HTMLCanvasElement | null
  /** Normalised centroid of the subject matte, for framing. */
  subject: { x: number; y: number } | null
  /**
   * Whether the matte is clean enough to drive the background melt.
   * On a photo with no real subject (an empty room, a table) the model
   * still returns a mask — of scattered furniture — and popping it
   * punches holes through the picture. Measured in the harness
   * 2026-09-20 on a pub interior. Parallax is unaffected.
   */
  popSafe: boolean
}

type Status = 'idle' | 'loading' | 'ready' | 'unavailable'

// Pinned version: an unpinned CDN import would silently change model
// APIs under us mid-event.
const TRANSFORMERS_VERSION = '3.7.2'
const CDN_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}`

// Verified working in a real browser against a real wedding photo
// (2026-09-20, transformers.js 3.7.2, wasm backend):
//   depth  → { predicted_depth: Tensor, depth: RawImage(ch 1) }
//   matte  → [ RawImage(ch 4) ] with the subject in the ALPHA channel
// The later entries are untested fallbacks, kept only so a model
// being pulled from the hub doesn't kill the feature outright.
const DEPTH_CANDIDATES: Array<[string, string]> = [
  ['depth-estimation', 'onnx-community/depth-anything-v2-small'],
  ['depth-estimation', 'Xenova/depth-anything-small-hf'],
]
const MATTE_CANDIDATES: Array<[string, string]> = [
  ['background-removal', 'briaai/RMBG-1.4'],
  ['image-segmentation', 'Xenova/modnet'],
  ['image-segmentation', 'briaai/RMBG-1.4'],
]

const LOAD_TIMEOUT_MS = 120_000
const RUN_TIMEOUT_MS = 45_000

let status: Status = 'idle'
let lib: any = null
let depthPipe: any = null
let mattePipe: any = null
let loadPromise: Promise<boolean> | null = null
let preferWebGPU = false
/** Rolling mean analysis time, surfaced in the menu so the operator
 *  can see whether the machine is keeping up. */
let lastMs = 0

export function setPreferWebGPU(on: boolean): void {
  preferWebGPU = on
}

export function lastAnalysisMs(): number {
  return lastMs
}

const cache = new Map<string, PhotoAnalysis>()
const inFlight = new Set<string>()
const queue: Array<() => Promise<void>> = []
let draining = false

export function aiStatus(): Status {
  return status
}

export function analysisFor(id: string): PhotoAnalysis | null {
  return cache.get(id) ?? null
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

/** Load transformers.js + both pipelines. Idempotent; safe to call
 *  from several places. Resolves false when AI is unavailable. */
export function ensureModels(onProgress?: (pct: number, label: string) => void): Promise<boolean> {
  if (status === 'ready') return Promise.resolve(true)
  if (status === 'unavailable') return Promise.resolve(false)
  if (loadPromise) return loadPromise

  status = 'loading'
  loadPromise = (async () => {
    try {
      lib = await withTimeout(
        // webpackIgnore keeps this a true runtime fetch — the module
        // and the portal never bundle or resolve transformers.js.
        import(/* webpackIgnore: true */ `${CDN_URL}/+esm`),
        LOAD_TIMEOUT_MS,
      )
      if (!lib?.pipeline) throw new Error('no pipeline export')

      // Models are large; report coarse progress so the operator can
      // see the display warming up before guests arrive.
      let seen = 0
      const progress = (p: any) => {
        if (p?.status === 'progress' && typeof p.progress === 'number') {
          seen = Math.max(seen, p.progress)
          onProgress?.(Math.min(99, Math.round(seen)), p.file ?? 'model')
        }
      }

      // WASM by default, deliberately. In testing (headless Chromium,
      // 2026-09-20) navigator.gpu reported an adapter and then depth
      // inference HUNG indefinitely — the classic "claims support,
      // then never returns". WASM is slower but finishes predictably,
      // and a stalled projector mid-reception is the worst outcome
      // available. WebGPU is opt-in from the menu for anyone who has
      // rehearsed it on the actual machine.
      const device = preferWebGPU && (await hasWebGPU()) ? 'webgpu' : 'wasm'
      const opts = { device, dtype: 'fp32', progress_callback: progress }

      depthPipe = await firstWorking(DEPTH_CANDIDATES, opts)
      mattePipe = await firstWorking(MATTE_CANDIDATES, opts)

      if (!depthPipe && !mattePipe) throw new Error('no pipelines available')

      status = 'ready'
      onProgress?.(100, 'ready')
      return true
    } catch {
      status = 'unavailable'
      depthPipe = null
      mattePipe = null
      return false
    }
  })()
  return loadPromise
}

async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as any).gpu
    if (!gpu?.requestAdapter) return false
    const adapter = await withTimeout(gpu.requestAdapter(), 4000)
    return Boolean(adapter)
  } catch {
    return false
  }
}

async function firstWorking(candidates: Array<[string, string]>, opts: any): Promise<any> {
  for (const [task, model] of candidates) {
    try {
      const p = await withTimeout(lib.pipeline(task, model, opts), LOAD_TIMEOUT_MS)
      if (p) return p
    } catch {
      // try the next candidate
    }
  }
  return null
}

/** RawImage (transformers.js) → canvas, tolerating 1- and 4-channel
 *  outputs and both the older and newer RawImage shapes. */
function rawImageToCanvas(raw: any): HTMLCanvasElement | null {
  try {
    if (!raw) return null
    // Deliberately NOT raw.toCanvas(): for RMBG's RGBA output that
    // helper returns a canvas whose alpha channel is collapsed to
    // 0..1 (measured 2026-09-20: aMin 0, aMax 1, against raw alpha
    // mean 185). Sampling it made the whole subject transparent — the
    // background melt erased the photo instead of the background.
    // raw.data is correct, so always rebuild from that.
    const { data, width, height, channels } = raw
    if (!data || !width || !height) return null
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const out = ctx.createImageData(width, height)
    const ch = channels ?? data.length / (width * height)
    for (let i = 0, px = 0; px < width * height; px++) {
      if (ch === 1) {
        const v = data[px]!
        out.data[i++] = v; out.data[i++] = v; out.data[i++] = v; out.data[i++] = 255
      } else if (ch === 4) {
        out.data[i++] = data[px * 4]!
        out.data[i++] = data[px * 4 + 1]!
        out.data[i++] = data[px * 4 + 2]!
        out.data[i++] = data[px * 4 + 3]!
      } else {
        out.data[i++] = data[px * ch]!
        out.data[i++] = data[px * ch + 1] ?? data[px * ch]!
        out.data[i++] = data[px * ch + 2] ?? data[px * ch]!
        out.data[i++] = 255
      }
    }
    ctx.putImageData(out, 0, 0)
    return canvas
  } catch {
    return null
  }
}

/** Centroid of the bright (subject) region of a matte canvas. */
function centroidOf(canvas: HTMLCanvasElement): { x: number; y: number } | null {
  try {
    const step = Math.max(1, Math.floor(canvas.width / 64))
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)

    // Which channel actually carries the mask? RMBG hands back RGBA
    // with the subject in ALPHA (RGB is the photo itself, so reading
    // red would drag the centroid toward bright scenery). A 1-channel
    // model instead gives alpha=255 everywhere and the mask in
    // luminance. Decide by looking at whether alpha varies at all.
    let aMin = 255, aMax = 0
    for (let i = 3; i < data.length; i += 4 * 31) {
      const a = data[i]!
      if (a < aMin) aMin = a
      if (a > aMax) aMax = a
    }
    const useAlpha = aMax - aMin > 40

    let sx = 0, sy = 0, n = 0
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4
        const v = useAlpha ? data[i + 3]! : data[i]!
        if (v > 140) { sx += x; sy += y; n += 1 }
      }
    }
    if (n < 12) return null
    return { x: sx / n / width, y: sy / n / height }
  } catch {
    return null
  }
}

/**
 * Is this matte a coherent subject, or scattered debris? Two cheap
 * signals: how much of the frame it covers, and how solidly it fills
 * its own bounding box. A couple in frame is a large, solid blob; the
 * chairs and tables of an empty room are a sprawl of thin fragments
 * whose bbox covers everything while filling little of it.
 */
function matteIsPoppable(canvas: HTMLCanvasElement): boolean {
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return false
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const step = Math.max(1, Math.floor(width / 96))

    let aMin = 255, aMax = 0
    for (let i = 3; i < data.length; i += 4 * 31) {
      const a = data[i]!
      if (a < aMin) aMin = a
      if (a > aMax) aMax = a
    }
    const useAlpha = aMax - aMin > 40

    let on = 0, total = 0
    let minX = width, maxX = 0, minY = height, maxY = 0
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4
        total += 1
        if ((useAlpha ? data[i + 3]! : data[i]!) > 140) {
          on += 1
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (total === 0 || on === 0) return false

    const coverage = on / total
    const bboxArea = Math.max(1, ((maxX - minX) / step + 1) * ((maxY - minY) / step + 1))
    const fill = on / bboxArea

    // Too small to notice, or so large the "background" is a sliver.
    if (coverage < 0.06 || coverage > 0.88) return false
    // A solid subject fills most of its own box; debris does not.
    return fill > 0.5
  } catch {
    return false
  }
}

function drain(): void {
  if (draining) return
  draining = true
  const step = async () => {
    const job = queue.shift()
    if (!job) { draining = false; return }
    try { await job() } catch { /* one photo failing is not fatal */ }
    // Yield to the compositor so the slideshow never stutters.
    setTimeout(step, 120)
  }
  void step()
}

/**
 * Queue analysis for one photo. Returns immediately; the result lands
 * in the cache and `onDone` fires if the caller still cares.
 */
export function analysePhoto(id: string, src: string, onDone?: (a: PhotoAnalysis) => void): void {
  if (cache.has(id)) { onDone?.(cache.get(id)!); return }
  if (inFlight.has(id)) return
  if (status === 'unavailable') return
  inFlight.add(id)

  queue.push(async () => {
    const startedAt = Date.now()
    try {
      const ok = await ensureModels()
      if (!ok) { inFlight.delete(id); return }

      let depth: HTMLCanvasElement | null = null
      let matte: HTMLCanvasElement | null = null

      if (depthPipe) {
        try {
          const out: any = await withTimeout(depthPipe(src), RUN_TIMEOUT_MS)
          depth = rawImageToCanvas(out?.depth ?? out?.predicted_depth ?? out)
        } catch { /* parallax unavailable for this photo */ }
      }

      if (mattePipe) {
        try {
          const out: any = await withTimeout(mattePipe(src), RUN_TIMEOUT_MS)
          // background-removal → RawImage(RGBA); image-segmentation →
          // [{ mask: RawImage }]
          const raw = Array.isArray(out) ? (out[0]?.mask ?? out[0]) : out
          matte = rawImageToCanvas(raw)
        } catch { /* subject pop unavailable for this photo */ }
      }

      const analysis: PhotoAnalysis = {
        depth,
        matte,
        subject: matte ? centroidOf(matte) : null,
        popSafe: matte ? matteIsPoppable(matte) : false,
      }
      if (cache.size > 80) cache.clear()
      cache.set(id, analysis)
      lastMs = Date.now() - startedAt
      onDone?.(analysis)
    } finally {
      inFlight.delete(id)
    }
  })
  drain()
}

/** Drop everything — used when the operator turns AI effects off. */
export function resetAnalysisCache(): void {
  cache.clear()
  queue.length = 0
}
