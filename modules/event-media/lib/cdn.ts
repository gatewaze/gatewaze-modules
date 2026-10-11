/**
 * Where browsers fetch event media from.
 *
 * Supabase's `/render/image/` endpoint resizes on the fly and bills per
 * transformation, which is what made image-heavy pages expensive. With a
 * Bunny pull zone in front of the bucket, browsers instead fetch the
 * plain `/object/public/` path through Bunny and Bunny does the resizing,
 * so Supabase serves each original once and never transforms it.
 *
 * Configure with BUNNY_PULLZONE_URL (the zone's origin must be this
 * project's Supabase URL) and BUNNY_CDN_ENABLED=true. The same names the
 * platform portal uses, so one setting covers both.
 *
 * Only BROWSER-facing URLs go through here. URLs handed to image models
 * stay direct: they include short-lived scratch files that are deleted
 * straight after use, and there is nothing to gain from caching those.
 */

export interface CdnConfig {
  /** e.g. https://example.b-cdn.net — no trailing slash required. */
  zone: string | null
}

/** Read and validate the CDN settings once, at mount. */
export function cdnConfigFromEnv(env: Record<string, string | undefined>): CdnConfig {
  const on = (env['BUNNY_CDN_ENABLED'] ?? '').trim().toLowerCase() === 'true'
  const raw = (env['BUNNY_PULLZONE_URL'] ?? '').trim().replace(/\/+$/, '')
  // Only an https origin is accepted. A typo here would otherwise send
  // every photo to a host that does not exist and blank the projector.
  const zone = on && /^https:\/\/[a-z0-9.-]+$/i.test(raw) ? raw : null
  return { zone }
}

/** An original, as a browser should fetch it. */
export function browserObjectUrl(
  cfg: CdnConfig, supabaseUrl: string, bucket: string, path: string,
): string {
  // Not encoded, deliberately: this must produce exactly the URL the
  // code produced before, so switching the CDN off changes nothing.
  // Stored names are already sanitised on upload.
  const rel = `/storage/v1/object/public/${bucket}/${path}`
  return `${cfg.zone ?? supabaseUrl}${rel}`
}

/**
 * A resized copy, as a browser should fetch it.
 *
 * Through Bunny this is the object path plus Bunny Optimizer's `width` and
 * `quality`; directly it is Supabase's render endpoint. Bunny keeps the
 * aspect ratio when only a width is given, which is the `contain`
 * behaviour the Supabase URL asks for explicitly.
 */
export function browserSizedUrl(
  cfg: CdnConfig, supabaseUrl: string, bucket: string, path: string, width: number, quality = 80,
): string {
  const w = Math.max(16, Math.min(4096, Math.round(width)))
  const q = Math.max(1, Math.min(100, Math.round(quality)))
  if (cfg.zone) {
    return `${browserObjectUrl(cfg, supabaseUrl, bucket, path)}?width=${w}&quality=${q}`
  }
  return `${supabaseUrl}/storage/v1/render/image/public/${bucket}/${path}` +
    `?width=${w}&resize=contain&quality=${q}`
}
