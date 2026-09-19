// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * Client-side photo analysis for the projector display: palette
 * extraction (ambient colour spill) and CORS-safe image loading.
 *
 * Everything here is plain canvas work — no models, no network beyond
 * the image itself — so it always works and never blocks a slide.
 * Storage + render endpoints both send `access-control-allow-origin: *`
 * (verified 2026-09-20), so `crossOrigin = 'anonymous'` keeps the
 * canvas untainted and makes getImageData / WebGL textures legal.
 */

export interface PhotoPalette {
  /** Darkened dominant colour — used behind the stage + gutters. */
  ambient: string
  /** Most saturated readable colour — used for accents/glows. */
  accent: string
  /** True when the photo is mostly dark (drives overlay contrast). */
  isDark: boolean
}

const paletteCache = new Map<string, PhotoPalette>()
const imageCache = new Map<string, HTMLImageElement>()

/** Load an image CORS-clean. Resolves null rather than throwing so a
 *  single bad file can never break the slideshow. */
export function loadImage(src: string): Promise<HTMLImageElement | null> {
  const cached = imageCache.get(src)
  if (cached?.complete && cached.naturalWidth > 0) return Promise.resolve(cached)
  return new Promise((resolve) => {
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    const done = (ok: boolean) => resolve(ok ? img : null)
    img.onload = () => {
      if (imageCache.size > 60) imageCache.clear()
      imageCache.set(src, img)
      done(true)
    }
    img.onerror = () => done(false)
    img.src = src
  })
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rf = r / 255, gf = g / 255, bf = b / 255
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) / 6
  else if (max === gf) h = ((bf - rf) / d + 2) / 6
  else h = ((rf - gf) / d + 4) / 6
  return [h, s, l]
}

function hslCss(h: number, s: number, l: number, a = 1): string {
  return `hsla(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%, ${a})`
}

/**
 * Extract an ambient + accent colour by bucketing a 48px thumbnail
 * into a coarse hue/lightness histogram. Cheap (a few ms) and stable
 * across re-renders thanks to the cache.
 */
export async function extractPalette(src: string, cacheKey: string): Promise<PhotoPalette | null> {
  const cached = paletteCache.get(cacheKey)
  if (cached) return cached

  const img = await loadImage(src)
  if (!img) return null

  try {
    const size = 48
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, size, size)
    const { data } = ctx.getImageData(0, 0, size, size)

    // 24 hue buckets; track population, mean saturation, mean lightness.
    const buckets = Array.from({ length: 24 }, () => ({ n: 0, s: 0, l: 0, h: 0 }))
    let totalL = 0
    let counted = 0

    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3]!
      if (a < 128) continue
      const [h, s, l] = rgbToHsl(data[i]!, data[i + 1]!, data[i + 2]!)
      totalL += l
      counted += 1
      // Ignore near-greyscale pixels when choosing hue — they'd all
      // pile into bucket 0 and make every photo look red.
      if (s < 0.12) continue
      const b = buckets[Math.min(23, Math.floor(h * 24))]!
      b.n += 1
      b.s += s
      b.l += l
      b.h += h
    }

    if (counted === 0) return null
    const meanL = totalL / counted

    const best = buckets.reduce((acc, b) => (b.n > acc.n ? b : acc), buckets[0]!)
    let ambient: string
    let accent: string

    if (best.n < counted * 0.02) {
      // Essentially monochrome photo — use a neutral wash.
      ambient = hslCss(0, 0, Math.min(0.16, meanL * 0.35))
      accent = hslCss(0, 0, 0.72)
    } else {
      const h = best.h / best.n
      const s = best.s / best.n
      ambient = hslCss(h, Math.min(0.55, s * 0.8), Math.min(0.18, 0.06 + meanL * 0.18))
      accent = hslCss(h, Math.min(0.85, s * 1.25), 0.62)
    }

    const palette: PhotoPalette = { ambient, accent, isDark: meanL < 0.42 }
    if (paletteCache.size > 120) paletteCache.clear()
    paletteCache.set(cacheKey, palette)
    return palette
  } catch {
    // Tainted canvas or a browser quirk — ambient spill just stays put.
    return null
  }
}

/** Does this photo letterbox on a 16:9 stage (i.e. leave visible bars)? */
export function needsFill(img: { naturalWidth: number; naturalHeight: number }): boolean {
  if (!img.naturalWidth || !img.naturalHeight) return false
  const ar = img.naturalWidth / img.naturalHeight
  return Math.abs(ar - 16 / 9) > 0.06
}
