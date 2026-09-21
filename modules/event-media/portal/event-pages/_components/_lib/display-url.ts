/**
 * The URL the projector fetches for one photo, sized for the screen.
 *
 * The API hands over the original. Resizing depends on where it lives:
 * Supabase resizes through its render endpoint, while a CDN in front of
 * the bucket resizes the plain object itself.
 *
 * Getting this wrong is expensive rather than visible. Turning a CDN
 * URL into a render path still works — Bunny just proxies it back to
 * Supabase's render endpoint — so every slide is quietly billed as a
 * Supabase transformation, which is the cost the CDN exists to remove.
 */
export function sizedDisplayUrl(url: string, width: number, height: number, quality = 82): string {
  if (!url.includes('/object/public/')) return url
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    return url
  }
  const w = Math.max(16, Math.min(4096, Math.round(width)))
  const h = Math.max(16, Math.min(4096, Math.round(height)))
  const q = Math.max(1, Math.min(100, Math.round(quality)))
  if (/\.supabase\.(co|in)$/i.test(host)) {
    return `${url.replace('/object/public/', '/render/image/public/')}` +
      `?width=${w}&height=${h}&resize=contain&quality=${q}`
  }
  // Bunny Optimizer keeps the aspect ratio when no aspect_ratio is given,
  // so width and height bound the image the way `contain` does above.
  return `${url}?width=${w}&height=${h}&quality=${q}`
}
