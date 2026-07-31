/**
 * Image normalisation + shortlist (spec §6, §10.2, OQ2). `sharp` strips EXIF and
 * bounds size; the shortlist perceptual-dedups near-identical shots and caps how
 * many images reach the vision step so the model never receives the full gallery.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sharp = any;

async function sharpMod(): Promise<Sharp> {
  const mod = await import('sharp');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any).default ?? mod;
}

const MAX_EDGE = 1920;
const JPEG_QUALITY = 82;

export interface NormalisedImage {
  buffer: Buffer;
  mimeType: 'image/jpeg';
}

/** Strip EXIF, cap the longest edge, re-encode to JPEG. Throws on undecodable input. */
export async function normalise(input: Buffer): Promise<NormalisedImage> {
  const sharp = await sharpMod();
  const buffer = await sharp(input)
    .rotate() // apply EXIF orientation, then drop metadata
    .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return { buffer, mimeType: 'image/jpeg' };
}

/**
 * Normalise a dealer logo for use as a video watermark: rasterise (handles SVG),
 * bound the size, and output PNG so transparency is preserved for the overlay.
 */
export async function normaliseLogo(input: Buffer): Promise<Buffer> {
  const sharp = await sharpMod();
  return await sharp(input, { density: 200 })
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
}

/** 64-bit average-hash of an image (perceptual). Returns a hex string. */
export async function averageHash(input: Buffer): Promise<string> {
  const sharp = await sharpMod();
  const raw = await sharp(input).greyscale().resize(8, 8, { fit: 'fill' }).raw().toBuffer();
  let sum = 0;
  for (const b of raw) sum += b;
  const avg = sum / raw.length;
  let bits = '';
  for (const b of raw) bits += b >= avg ? '1' : '0';
  // pack 64 bits into hex
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    d += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return d;
}

export interface ShortlistItem {
  index: number; // index into the original gallery
  buffer: Buffer;
  hash: string;
}

/**
 * Perceptual-dedup a set of normalised image buffers and cap to `max`. Keeps the
 * first representative of each near-identical cluster (hamming < threshold),
 * preserving original order. Returns the shortlisted items with their original
 * gallery index (so downstream can map back to storage paths).
 */
export async function shortlist(buffers: Buffer[], max: number): Promise<ShortlistItem[]> {
  const kept: ShortlistItem[] = [];
  const DUP_THRESHOLD = 6; // ≤6/64 bits differ → treat as the same shot
  for (let i = 0; i < buffers.length; i++) {
    let hash: string;
    try {
      hash = await averageHash(buffers[i]);
    } catch {
      continue; // skip undecodable
    }
    if (kept.some((k) => hamming(k.hash, hash) <= DUP_THRESHOLD)) continue;
    kept.push({ index: i, buffer: buffers[i], hash });
    if (kept.length >= max) break;
  }
  return kept;
}
