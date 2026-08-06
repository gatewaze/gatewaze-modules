// @ts-nocheck — puppeteer-core/sharp/supabase-js resolved at module-host install time.

/**
 * Speaker-card renderer: substitutes speaker/talk/event values into the
 * self-contained HTML templates (templates/speaker-card-*.html) and
 * screenshots them with the worker image's pinned system Chromium at 2x,
 * then downscales (Lanczos) to each format's export size.
 *
 * Security posture (speaker fields come from the public CFP flow):
 *   - every substituted value is HTML-escaped before it touches the template;
 *   - the avatar is fetched server-side, so the URL is restricted to
 *     https with a private/loopback/metadata-IP resolve check (SSRF), or a
 *     bare `media` storage path; the fetched bytes must be an image and are
 *     inlined as a data: URI so the render itself needs no network.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

export const TEMPLATE_VERSION = '1.0.0';

export interface CardFormatSpec {
  format: 'square' | 'story' | 'landscape';
  templateFile: string;
  exportWidth: number;
  exportHeight: number;
}

export const CARD_FORMATS: CardFormatSpec[] = [
  { format: 'square', templateFile: 'speaker-card-square.html', exportWidth: 1200, exportHeight: 1200 },
  { format: 'story', templateFile: 'speaker-card-story.html', exportWidth: 1080, exportHeight: 1920 },
  { format: 'landscape', templateFile: 'speaker-card-landscape.html', exportWidth: 1200, exportHeight: 630 },
];

const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME_RE = /^image\/(png|jpe?g|webp|gif|avif|svg\+xml)/i;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * {{scope.field}} substitution (same convention as event-invites'
 * replaceVariables), but HTML-escaping every value — the invites helper
 * does not escape, and these values are user-submitted. Unresolved
 * variables are left in place: the templates' own scripts treat an
 * unresolved {{brand.*}} / {{talk.title}} as "use the default / hide".
 */
export function substituteVariables(template: string, context: Record<string, Record<string, string | undefined>>): string {
  return template.replace(/\{\{(\w+)\.(\w+)\}\}/g, (match, scope, field) => {
    const value = context?.[scope]?.[field];
    if (value === undefined || value === null) return match;
    // data: URIs (avatar/lockup we inlined ourselves) are attribute-safe as-is;
    // escaping their base64 payload is harmless but escaping the commas/plus
    // in an SVG data URI is not needed either — they contain no HTML metachars
    // after our scheme check. Escape everything uniformly for safety.
    return escapeHtml(String(value));
  });
}

function ipIsPrivate(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    const [a, b] = p;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local incl. metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) return ipIsPrivate(lower.slice(7));
    return false;
  }
  return true;
}

export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error(`avatar scheme not allowed: ${url.protocol}`);
  // URL.hostname keeps the brackets on IPv6 literals — strip them so the
  // literal hits ipIsPrivate directly instead of a doomed DNS lookup.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ip = isIP(host) ? host : (await lookup(host)).address;
  if (ipIsPrivate(ip)) throw new Error(`avatar host resolves to a blocked IP`);
  return url;
}

const MAX_AVATAR_REDIRECTS = 3;

/**
 * SSRF-guarded image fetch. Redirects are followed MANUALLY so every hop is
 * re-validated (redirect:'follow' would let a public host 302 the worker into
 * metadata/cluster-internal targets — the standard bypass for a check-then-
 * fetch guard). The body is streamed with a running byte cap instead of
 * buffering first. Residual risk: resolve-then-connect still allows a
 * low-TTL DNS rebind between our lookup and undici's own — same documented
 * limitation as vehicle-video's ssrf-guard; the private-IP check plus the
 * image content-type requirement keeps the practical surface to blind probes.
 */
async function fetchPublicImage(rawUrl: string): Promise<{ buf: Buffer; mime: string } | null> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_AVATAR_REDIRECTS; hop++) {
    await assertPublicHttpsUrl(current);
    const res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return null;
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!IMAGE_MIME_RE.test(type)) return null;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > AVATAR_MAX_BYTES) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > AVATAR_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    const buf = Buffer.concat(chunks);
    if (buf.length === 0) return null;
    return { buf, mime: type.split(';')[0] };
  }
  return null; // redirect chain too long
}

/**
 * Resolve the avatar to a data: URI. Accepts:
 *   - a bare storage path in the `media` bucket (downloaded service-role);
 *   - an https URL (SSRF-guarded fetch);
 *   - an existing data:image/ URI (passed through).
 * Returns null (silhouette fallback) on anything else or any failure —
 * a missing avatar is a shippable card, not an error.
 */
export async function resolveAvatarDataUri(supabase, avatarUrl: string | null | undefined): Promise<string | null> {
  if (!avatarUrl) return null;
  const trimmed = String(avatarUrl).trim();
  if (!trimmed) return null;
  try {
    if (/^data:image\//i.test(trimmed)) return trimmed;
    if (/^https:/i.test(trimmed)) {
      // Own-storage public URLs skip the generic fetch and use the storage API.
      const storageMatch = trimmed.match(/\/storage\/v1\/object\/public\/media\/(.+)$/);
      if (storageMatch) return await storageDataUri(supabase, decodeURIComponent(storageMatch[1]));
      const image = await fetchPublicImage(trimmed);
      if (!image) return null;
      return `data:${image.mime};base64,${image.buf.toString('base64')}`;
    }
    if (/^[\w][\w./-]*$/.test(trimmed) && !trimmed.includes('..')) {
      // Bare media-bucket storage path (the admin resolves these the same way).
      return await storageDataUri(supabase, trimmed);
    }
    return null;
  } catch {
    return null;
  }
}

async function storageDataUri(supabase, path: string): Promise<string | null> {
  const { data } = await supabase.storage.from('media').download(path);
  if (!data) return null;
  const buf = Buffer.from(await data.arrayBuffer());
  if (buf.length === 0 || buf.length > AVATAR_MAX_BYTES) return null;
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  const mime =
    ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : ext === 'svg' ? 'image/svg+xml'
    : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** The templates remove the <image> element entirely when the avatar is
 *  absent (an empty href renders Chromium's broken-image icon); their
 *  in-page preview script handles an unresolved {{speaker.avatar_url}}
 *  the same way, so leaving the variable unsubstituted is the correct
 *  "no avatar" signal. */

function chromiumExecutablePath(): string {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH ?? process.env.CHROMIUM_PATH;
  if (fromEnv) return fromEnv;
  if (process.platform === 'darwin') {
    const macPaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const p of macPaths) if (existsSync(p)) return p;
  }
  return '/usr/bin/chromium'; // worker image's pinned system Chromium
}

export interface RenderCardInput {
  speaker: { full_name: string; job_title?: string | null; company?: string | null; avatar_data_uri?: string | null };
  talk: { title?: string | null };
  event: { date_short: string; city: string };
  brand?: Partial<Record<'accent' | 'accent_bright' | 'accent_dark' | 'wave_from' | 'lockup_url', string>>;
}

export interface RenderedCard {
  format: CardFormatSpec['format'];
  png: Buffer;
  width: number;
  height: number;
}

function buildContext(input: RenderCardInput): Record<string, Record<string, string | undefined>> {
  const ctx: Record<string, Record<string, string | undefined>> = {
    speaker: {
      full_name: input.speaker.full_name,
      job_title: input.speaker.job_title ?? '',
      company: input.speaker.company ?? '',
      ...(input.speaker.avatar_data_uri ? { avatar_url: input.speaker.avatar_data_uri } : {}),
    },
    // Always substitute talk.title (empty string when absent): the templates'
    // preview script fills SAMPLE data into any unresolved text variable, and
    // an empty title is what triggers the hide-the-line behaviour.
    talk: { title: input.talk.title ?? '' },
    event: {
      date_short: input.event.date_short,
      city: input.event.city,
    },
  };
  if (input.brand) ctx.brand = { ...input.brand };
  return ctx;
}

/** Loads a template's HTML by file name — from the git template source when
 *  configured, else the module's vendored templates dir. */
export type TemplateLoader = (fileName: string) => Promise<string>;

/** Directory-backed loader (vendored templates / tests). */
export function dirTemplateLoader(templatesDir: string): TemplateLoader {
  return (fileName: string) => readFile(join(templatesDir, fileName), 'utf8');
}

/** Render every format for one speaker in a single browser session. */
export async function renderSpeakerCards(
  loadTemplate: TemplateLoader,
  input: RenderCardInput,
  formats: CardFormatSpec[] = CARD_FORMATS,
): Promise<RenderedCard[]> {
  const context = buildContext(input);
  const browser = await puppeteer.launch({
    executablePath: chromiumExecutablePath(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--disable-crashpad',
      '--force-color-profile=srgb',
    ],
  });
  try {
    const rendered: RenderedCard[] = [];
    for (const spec of formats) {
      const template = await loadTemplate(spec.templateFile);
      const html = substituteVariables(template, context);
      const cardW = Number((html.match(/#card\s*{[^}]*width:\s*(\d+)px/) ?? [])[1]) || spec.exportWidth;
      const cardH = Number((html.match(/#card\s*{[^}]*height:\s*(\d+)px/) ?? [])[1]) || spec.exportHeight;

      const page = await browser.newPage();
      try {
        await page.setViewport({ width: cardW, height: cardH, deviceScaleFactor: 2 });
        // Templates are fully self-contained (fonts + art as data URIs), so
        // no network access happens during load.
        await page.setContent(html, { waitUntil: 'load', timeout: 60_000 });
        await page.evaluate(() => document.fonts.ready);
        await new Promise((r) => setTimeout(r, 300)); // auto-fit script settle
        const shot = await page.screenshot({ type: 'png' });
        const png = await sharp(Buffer.from(shot))
          .resize(spec.exportWidth, spec.exportHeight, { kernel: 'lanczos3', fit: 'fill' })
          .png()
          .toBuffer();
        rendered.push({ format: spec.format, png, width: spec.exportWidth, height: spec.exportHeight });
      } finally {
        await page.close().catch(() => {});
      }
    }
    return rendered;
  } finally {
    await browser.close().catch(() => {});
  }
}
