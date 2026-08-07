// @ts-nocheck — qrcode resolved at module-host install time.

/**
 * LinkedIn QR code for the speaker deck's title slide.
 *
 * The address comes from the speaker's own talk submission, and the slide
 * captions it "Connect with me on LinkedIn" — so it is validated to be a
 * real LinkedIn address before we render it. Without that check a speaker
 * could point an audience-facing QR code at any site while we vouch for it.
 *
 * Everything here degrades to null rather than throwing. A deck without a
 * QR code is fine; a kit that fails to build because of one is not.
 */

/** linkedin.com and its country subdomains (uk.linkedin.com etc.). */
function isLinkedInHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'linkedin.com' || h.endsWith('.linkedin.com');
}

/**
 * Canonical https LinkedIn URL, or null when the stored value isn't one.
 * Speakers type this field by hand, so it arrives in several shapes, e.g.
 * "linkedin.com/in/jane" with no scheme.
 */
export function normalizeLinkedInUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  // A bare handle carries no profile path, so there's nothing safe to build.
  if (value.startsWith('@')) return null;

  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!isLinkedInHost(url.hostname)) return null;
  // A host with no path is the LinkedIn home page, not a profile.
  if (url.pathname === '/' || url.pathname === '') return null;

  url.protocol = 'https:';
  url.hash = '';
  url.search = '';
  // Strip any user:password segment. The host is genuinely LinkedIn either
  // way, but many scanner apps preview the raw URL, so text like
  // "https://verify-your-account@linkedin.com/in/x" reads as a message from
  // us on a slide where we caption the code "Connect with me on LinkedIn".
  url.username = '';
  url.password = '';
  return url.toString();
}

/**
 * PNG of a QR code for `url`, dark on white so it scans against the
 * card-black title slide. Returns null when the qrcode package isn't
 * present in this worker image yet, or when encoding fails.
 */
export async function renderLinkedInQrPng(url: string, sizePx = 512): Promise<Buffer | null> {
  try {
    const mod = await import('qrcode');
    const QRCode = mod?.default ?? mod;
    if (typeof QRCode?.toBuffer !== 'function') return null;
    return await QRCode.toBuffer(url, {
      type: 'png',
      width: sizePx,
      // Quiet zone. Below 2 modules some scanners fail against a dark slide.
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000FF', light: '#FFFFFFFF' },
    });
  } catch {
    return null;
  }
}

/** Convenience: stored value in, scannable PNG out, null at any failure. */
export async function buildLinkedInQr(
  raw: string | null | undefined,
): Promise<{ url: string; png: Buffer } | null> {
  const url = normalizeLinkedInUrl(raw);
  if (!url) return null;
  const png = await renderLinkedInQrPng(url);
  if (!png) return null;
  return { url, png };
}
