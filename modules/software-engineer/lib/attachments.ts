// @ts-nocheck
/**
 * Issue attachments → the agent's eyes. A reporter can paste screenshots into an issue (via our
 * Issues tab, which uploads to the platform `media` bucket, OR directly in GitHub's web UI, which
 * hosts them under github.com/user-attachments). Either way the image lives at a URL in the issue
 * body as markdown `![alt](url)`. To let the agent actually SEE them — the way a Claude Code session
 * sees a pasted image — we download each into the workspace and let the agent Read them (the Read
 * tool renders images visually to the model).
 *
 * Security:
 *  - SSRF: only fetch from an allowlist (the platform's own Supabase storage, *.supabase.co,
 *    GitHub's attachment hosts, plus any SE_ATTACHMENT_HOST_ALLOW extras). An arbitrary
 *    `![](http://169.254.169.254/…)` in a body is ignored, never fetched.
 *  - Content is validated by MAGIC BYTES, not the server's content-type header — only real
 *    PNG/JPEG/GIF/WebP are written to disk.
 *  - Bounded: at most MAX_FILES images, each capped at MAX_BYTES.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_FILES = 8;
const MAX_BYTES = 15 * 1024 * 1024;
export const ATTACH_DIRNAME = '.se-attachments';

/** Markdown image `![alt](url)` and bare `<url>`/`url` on their own — capture the URL. */
export function extractImageUrls(body: string): string[] {
  const out: string[] = [];
  if (!body) return out;
  const md = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = md.exec(body))) out.push(m[1]);
  // GitHub also emits bare <img src="…"> for some pastes.
  const img = /<img[^>]+src=["']([^"']+)["']/gi;
  while ((m = img.exec(body))) out.push(m[1]);
  return [...new Set(out)];
}

function hostAllowed(u: URL): boolean {
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  // The platform's own storage origin (self-hosted or cloud) — the primary case. Exact-origin only:
  // a bare `.supabase.co` suffix would admit ANY attacker-controlled free-tier project on the shared
  // domain, which could 302 an SSRF payload past this check (see downloadIssueAttachments redirects).
  try { if (process.env.SUPABASE_URL && u.origin === new URL(process.env.SUPABASE_URL).origin) return true; } catch { /* bad env */ }
  if (h.endsWith('.githubusercontent.com')) return true;                       // user-images.githubusercontent.com
  if (h === 'github.com' && u.pathname.startsWith('/user-attachments/')) return true;
  const extra = (process.env.SE_ATTACHMENT_HOST_ALLOW || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (extra.includes(h)) return true;
  return false;
}

/** Literal private / loopback / link-local address (SSRF backstop on every redirect hop). Does NOT
 *  cover DNS-rebinding (a public name resolving to an internal IP) — out of scope for this tool. */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;               // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;      // CGNAT
  }
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true; // ULA / link-local IPv6
  return false;
}

/**
 * Fetch an attachment, following redirects MANUALLY so every hop is re-validated — the initial host
 * must be allowlisted (trusted infra: our Supabase or GitHub), and no hop may land on a private IP
 * (GitHub legitimately 302s user-attachments to a public signed store). Auth is sent only on hop 0.
 * Returns the final Response, or null if any hop fails the guard / too many hops.
 */
async function safeFetch(url: string, authHeader: Record<string, string>): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    let u: URL;
    try { u = new URL(current); } catch { return null; }
    if (u.protocol !== 'https:' || isPrivateHost(u.hostname)) return null;
    if (hop === 0 && !hostAllowed(u)) return null;             // entry point must be trusted
    const r = await fetch(current, { headers: hop === 0 ? authHeader : {}, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) return null;
      current = new URL(loc, current).href;                    // resolve + re-check next iteration
      continue;
    }
    return r;
  }
  return null; // redirect loop / too many hops
}

/** True if a URL is a permitted attachment host AND is a clean single URL safe to embed in markdown.
 *  Rejects whitespace / `)` / `<` / `>` / backtick / control chars — otherwise a validated hostname
 *  could carry a payload that closes the `![](...)` image early and injects arbitrary issue markdown. */
export function isAllowedAttachmentUrl(raw: string): boolean {
  if (typeof raw !== 'string' || /[\s)<>`\x00-\x1f]/.test(raw)) return false;
  try { return hostAllowed(new URL(raw)); } catch { return false; }
}

/** Sniff real image type from the first bytes. Returns the extension, or null if not an image. */
function sniffImage(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}

/**
 * Download the issue body's images into `<destRoot>/.se-attachments/`. Best-effort — returns the
 * number written and the dir (null if none). `token` is the project PAT, used only for GitHub-hosted
 * private-repo attachments.
 */
export async function downloadIssueAttachments(body: string, token: string | null, destRoot: string): Promise<{ count: number; dir: string | null; names: string[] }> {
  const urls = extractImageUrls(body).slice(0, MAX_FILES);
  if (!urls.length) return { count: 0, dir: null, names: [] };
  const dir = join(destRoot, ATTACH_DIRNAME);
  await mkdir(dir, { recursive: true });
  const names: string[] = [];
  for (const raw of urls) {
    try {
      const u = new URL(raw);
      const headers: Record<string, string> = {};
      // GitHub attachment hosts require the PAT for private-repo assets. Sent only on hop 0 (safeFetch
      // strips it on any redirect); Node/undici also strips Authorization on cross-origin redirects.
      if (token && (u.hostname === 'github.com' || u.hostname.endsWith('.githubusercontent.com'))) {
        headers.Authorization = `Bearer ${token}`;
      }
      const r = await safeFetch(raw, headers);   // SSRF-safe: allowlisted entry + per-hop re-validation
      if (!r || !r.ok) continue;
      const len = Number(r.headers.get('content-length') || 0);
      if (len > MAX_BYTES) continue;             // reject oversized before buffering (honest servers)
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_BYTES) continue;      // backstop for chunked/lying responses
      const ext = sniffImage(buf);       // validate by content, not header
      if (!ext) continue;
      const name = `screenshot-${names.length + 1}.${ext}`;
      await writeFile(join(dir, name), buf);
      names.push(name);
    } catch { /* skip this attachment */ }
  }
  return { count: names.length, dir: names.length ? dir : null, names };
}
