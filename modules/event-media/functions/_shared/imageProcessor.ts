// Image processing utilities using ImageMagick WASM
// This is the recommended approach for Supabase Edge Functions

import {
  ImageMagick,
  initializeImageMagick,
  MagickFormat,
  MagickGeometry,
  Percentage,
} from 'npm:@imagemagick/magick-wasm@0.0.30'

export interface ProcessedImages {
  thumbnail: Uint8Array
  medium: Uint8Array
  thumbnailWidth: number
  thumbnailHeight: number
  mediumWidth: number
  mediumHeight: number
}

// Initialize ImageMagick once
let imageMagickInitialized = false

async function ensureImageMagickInitialized() {
  if (!imageMagickInitialized) {
    const wasmBytes = await Deno.readFile(
      new URL(
        'magick.wasm',
        import.meta.resolve('npm:@imagemagick/magick-wasm@0.0.30')
      )
    )
    await initializeImageMagick(wasmBytes)
    imageMagickInitialized = true
  }
}

/**
 * Process an image to create thumbnail and medium versions with sharpening
 * Optimized to reduce CPU usage by creating both versions in separate reads
 */
export async function processImage(imageBuffer: Uint8Array): Promise<ProcessedImages> {
  try {
    await ensureImageMagickInitialized()

    let thumbnailWidth = 0
    let thumbnailHeight = 0
    let mediumWidth = 0
    let mediumHeight = 0
    let thumbnail: Uint8Array = new Uint8Array(0)
    let medium: Uint8Array = new Uint8Array(0)

    // ONE decode for both variants. The previous shape (two buffer
    // copies + two full-resolution decodes) blew the edge function's
    // memory ceiling (WORKER_RESOURCE_LIMIT) on ordinary multi-MP
    // phone photos, live 2026-09-20. Medium is written from the full
    // decode, then the already-shrunk image is downscaled again for
    // the thumb — peak memory is one decoded image instead of two.
    const buffer = new Uint8Array(imageBuffer)

    ImageMagick.read(buffer, (img) => {
      // Bake EXIF orientation in — the re-encode drops the tag, so
      // without this portrait phone photos render sideways.
      img.autoOrient()

      const aspectRatio = img.height / img.width

      // Medium (800px wide, or original if smaller)
      mediumWidth = Math.min(800, img.width)
      mediumHeight = Math.round(mediumWidth * aspectRatio)
      img.resize(mediumWidth, mediumHeight)
      img.sharpen(0, 0.3)
      // MUST copy inside the callback: `data` is a view into WASM
      // memory that is freed when the callback returns — returning it
      // directly yields a zero-filled buffer (live bug 2026-09-19).
      img.quality = 85
      medium = img.write(MagickFormat.Jpeg, (data) => new Uint8Array(data))

      // Thumbnail (350px wide) — downscaled from the medium-sized
      // image already in memory, never from the full decode.
      thumbnailWidth = Math.min(350, mediumWidth)
      thumbnailHeight = Math.round(thumbnailWidth * aspectRatio)
      img.resize(thumbnailWidth, thumbnailHeight)
      img.quality = 80
      thumbnail = img.write(MagickFormat.Jpeg, (data) => new Uint8Array(data))
    })

    return {
      thumbnail,
      medium,
      thumbnailWidth,
      thumbnailHeight,
      mediumWidth,
      mediumHeight,
    }
  } catch (error) {
    console.error('Error in processImage:', error)
    throw new Error(
      `Image processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}

/**
 * Generate storage paths for processed images
 */
export function generateImagePaths(originalPath: string): {
  thumbnailPath: string
  mediumPath: string
} {
  // Replace /original/ with /thumbnail/ or /medium/
  const thumbnailPath = originalPath
    .replace('/original/', '/thumbnail/')
    .replace(/\.\w+$/, '.jpg')

  const mediumPath = originalPath
    .replace('/original/', '/medium/')
    .replace(/\.\w+$/, '.jpg')

  return { thumbnailPath, mediumPath }
}
