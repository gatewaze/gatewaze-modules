// @ts-nocheck — supabase-js resolved at module-host install time.

/**
 * Speaker tracking link, umami provider.
 *
 * Replaces the legacy Short.io speaker link: mints an umami redirect link
 * (served at https://<portal-host>/go/<slug> through the analytics module's
 * /a/q/:slug proxy) and upserts the platform `redirects` row, keeping the
 * legacy attribution contract intact:
 *
 *   utm_source=speaker  utm_medium=direct  utm_campaign=<speaker profile id>
 *
 * — event_registrations.utm_campaign joins back to the speaker exactly as it
 * did with Short.io links, so registration attribution keeps working.
 *
 * The umami login/create calls are deliberately a small local copy of the
 * packages/api redirects helpers: workers can't call the JWT-gated
 * /api/redirects/create-bulk endpoint, and importing across packages risks
 * the dual-workspace symlink breakage (same reasoning as the newsletters
 * buzzword dispatch).
 */

const SLUG_RE = /^[A-Za-z0-9._~-]{1,80}$/;

export interface TrackingLinkResult {
  slug: string;
  shortUrl: string;
  destinationUrl: string;
  redirectId: string | null;
}

export function stringToSlug(str: string): string {
  return str
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/** The portal host that serves /go/<slug>. */
export function shortLinkDomain(): string {
  const explicit = (process.env.REDIRECT_PUBLIC_BASE_URL ?? '').trim();
  if (explicit) {
    try {
      return new URL(explicit).host.toLowerCase();
    } catch {
      /* fall through */
    }
  }
  return (process.env.PORTAL_HOST ?? '').trim().toLowerCase();
}

function shortUrlFor(domain: string, slug: string): string {
  const proto = domain.endsWith('.localhost') || domain === 'localhost' ? 'http' : 'https';
  return `${proto}://${domain}/go/${slug}`;
}

/** Umami's slug column is varchar(100); slugs are host-scoped `${domain}--${slug}`. */
function internalSlug(domain: string, slug: string): string {
  return `${domain}--${slug}`;
}

let umamiToken: { value: string; expiresAt: number } | null = null;

async function umamiLogin(baseUrl: string): Promise<string> {
  if (umamiToken && umamiToken.expiresAt > Date.now()) return umamiToken.value;
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.UMAMI_USERNAME || 'admin',
      password: process.env.UMAMI_PASSWORD || '',
    }),
  });
  if (!res.ok) throw new Error(`umami login failed: ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error('umami login returned no token');
  umamiToken = { value: body.token, expiresAt: Date.now() + 12 * 60 * 60 * 1000 };
  return body.token;
}

interface UmamiLink { id: string; name: string; url: string; slug: string }

async function findUmamiLinkBySlug(baseUrl: string, token: string, slug: string): Promise<UmamiLink | null> {
  const res = await fetch(`${baseUrl}/api/links?search=${encodeURIComponent(slug)}&pageSize=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: UmamiLink[] };
  return (body.data ?? []).find((l) => l.slug === slug) ?? null;
}

async function createUmamiLink(
  baseUrl: string,
  token: string,
  link: { path: string; originalUrl: string; title: string },
): Promise<UmamiLink> {
  const existing = await findUmamiLinkBySlug(baseUrl, token, link.path);
  if (existing) {
    if (existing.url !== link.originalUrl) {
      const upd = await fetch(`${baseUrl}/api/links/${existing.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: link.title, url: link.originalUrl, slug: link.path }),
      });
      if (!upd.ok) throw new Error(`umami link update failed: ${upd.status}`);
    }
    return { ...existing, url: link.originalUrl };
  }
  const res = await fetch(`${baseUrl}/api/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: link.title.slice(0, 100), url: link.originalUrl, slug: link.path }),
  });
  if (!res.ok) throw new Error(`umami link create failed: ${res.status} ${(await res.text()).slice(0, 120)}`);
  return (await res.json()) as UmamiLink;
}

/** Destination URL for a speaker link: the external registration page when
 *  the event is externally registered, else the portal register page. */
export function buildDestinationUrl(event: {
  event_id: string;
  event_slug: string | null;
  event_link: string | null;
  enable_native_registration: boolean | null;
}): string {
  const identifier = event.event_slug || event.event_id;
  let destination: string;
  if (event.event_link && !event.enable_native_registration) {
    destination = event.event_link;
  } else {
    const portalBase =
      (process.env.PORTAL_URL ?? '').trim() ||
      (process.env.APP_URL ?? '').trim() ||
      (shortLinkDomain() ? `https://${shortLinkDomain()}` : '');
    if (!portalBase) {
      if (event.event_link) return event.event_link;
      throw new Error('no portal base URL configured (PORTAL_URL / APP_URL / PORTAL_HOST)');
    }
    destination = `${portalBase.replace(/\/+$/, '')}/events/${identifier}/register`;
  }
  return destination;
}

/**
 * Mint (or reuse) the tracking link for one speaker+event. Idempotent:
 * the slug is deterministic (`<event_id>-<speaker-name>`), the umami create
 * upserts by slug, and a slug already owned by a DIFFERENT speaker gets a
 * numeric suffix, mirroring the legacy Short.io behaviour.
 */
export async function mintSpeakerTrackingLink(
  supabase,
  args: {
    speakerProfileId: string;
    speakerName: string;
    event: {
      event_id: string;
      event_slug: string | null;
      event_title: string;
      event_link: string | null;
      enable_native_registration: boolean | null;
    };
  },
): Promise<TrackingLinkResult> {
  const domain = shortLinkDomain();
  if (!domain) throw new Error('no short-link domain configured (PORTAL_HOST / REDIRECT_PUBLIC_BASE_URL)');
  if (!process.env.UMAMI_PASSWORD) throw new Error('UMAMI_PASSWORD not configured (umami link provider)');

  const destination = new URL(buildDestinationUrl(args.event));
  destination.searchParams.set('utm_source', 'speaker');
  destination.searchParams.set('utm_medium', 'direct');
  destination.searchParams.set('utm_campaign', args.speakerProfileId);
  const destinationUrl = destination.toString();
  if (destinationUrl.length > 500) throw new Error('destination URL exceeds umami limit (500 chars)');

  // Deterministic slug with collision suffixing against OTHER speakers.
  const nameSlug = stringToSlug(args.speakerName) || 'speaker';
  const eventSlugPart = stringToSlug(args.event.event_id) || 'event';
  // Keep domain + '--' + slug within umami's varchar(100).
  const maxSlugLen = Math.min(80, 100 - domain.length - 2);
  let base = `${eventSlugPart}-${nameSlug}`.slice(0, maxSlugLen).replace(/-+$/, '');
  if (!SLUG_RE.test(base)) throw new Error(`derived slug invalid: ${base}`);
  let slug = base;
  for (let suffix = 2; suffix < 50; suffix++) {
    const { data: existing } = await supabase
      .from('redirects')
      .select('id, source_id, source_type')
      .eq('domain', domain)
      .eq('path', slug)
      .maybeSingle();
    if (!existing) break;
    if (existing.source_type === 'speaker' && existing.source_id === args.speakerProfileId) break;
    slug = `${base.slice(0, maxSlugLen - 1 - String(suffix).length)}-${suffix}`;
  }

  const baseUrl = (process.env.UMAMI_BASE_URL || 'http://umami:3000').replace(/\/+$/, '');
  const token = await umamiLogin(baseUrl);
  const title = `Speaker: ${args.speakerName} (${args.event.event_id})`;
  const uLink = await createUmamiLink(baseUrl, token, {
    path: internalSlug(domain, slug),
    originalUrl: destinationUrl,
    title,
  });

  const shortUrl = shortUrlFor(domain, slug);
  const { data: row } = await supabase
    .from('redirects')
    .upsert(
      {
        shortio_id: uLink.id,
        provider: 'umami',
        domain,
        short_url: shortUrl,
        original_url: destinationUrl,
        path: slug,
        title,
        source_type: 'speaker',
        source_id: args.speakerProfileId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'shortio_id' },
    )
    .select('id')
    .maybeSingle();

  return { slug, shortUrl, destinationUrl, redirectId: row?.id ?? null };
}
