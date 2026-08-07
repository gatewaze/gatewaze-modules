// @ts-nocheck — jszip resolved at module-host install time.

/**
 * Git-driven template source for speaker promo cards.
 *
 * Card templates, brand colorways/lockups, and the event→brand mapping live
 * in a template repo (gatewaze-template-speaker-cards, same convention as
 * gatewaze-template-email/-blocks) so designers iterate without a module
 * deploy. The worker fetches the repo's zipball via the GitHub API (works
 * for public repos, and private ones when GITHUB_TOKEN is set), caches it
 * in-process, and falls back to the templates vendored with the module
 * whenever the repo is unset or unreachable — a bad push can never break
 * kit generation.
 *
 * Config: SPEAKER_CARDS_TEMPLATE_REPO = https://github.com/<org>/<repo>[#ref]
 * (GitHub-only by design: the zipball host is then GitHub-controlled, so
 * this fetch is not reachable by user-controlled URLs.)
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ZIP_BYTES = 25 * 1024 * 1024;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

export interface TemplateSource {
  origin: 'git' | 'vendored';
  ref: string | null;
  /** Repo-relative lookup, e.g. getFile('templates/speaker-card-square.html'). */
  getFile: (path: string) => Buffer | null;
}

export interface BrandVars {
  accent?: string;
  accent_bright?: string;
  accent_dark?: string;
  wave_from?: string;
  lockup_url?: string;
}

interface RepoRef {
  org: string;
  repo: string;
  ref: string;
}

export function parseTemplateRepoUrl(raw: string | undefined | null): RepoRef | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const [urlPart, refPart] = trimmed.split('#');
  const match = urlPart.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!match) return null;
  const ref = (refPart ?? 'main').trim();
  if (!/^[\w./-]{1,100}$/.test(ref)) return null;
  return { org: match[1], repo: match[2], ref };
}

let cache: { key: string; fetchedAt: number; files: Map<string, Buffer> } | null = null;

async function fetchRepoFiles(repo: RepoRef): Promise<Map<string, Buffer>> {
  const key = `${repo.org}/${repo.repo}#${repo.ref}`;
  if (cache && cache.key === key && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.files;

  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gatewaze-event-speakers',
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(
      `https://api.github.com/repos/${repo.org}/${repo.repo}/zipball/${encodeURIComponent(repo.ref)}`,
      { headers, redirect: 'follow', signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok) throw new Error(`zipball fetch failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_ZIP_BYTES) throw new Error(`zipball size out of bounds (${buf.length})`);

    const zip = await JSZip.loadAsync(buf);
    const files = new Map<string, Buffer>();
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      // GitHub zipballs prefix every path with "<org>-<repo>-<sha>/".
      const rel = name.split('/').slice(1).join('/');
      if (!rel || rel.includes('..')) continue;
      files.set(rel, Buffer.from(await entry.async('nodebuffer')));
    }
    cache = { key, fetchedAt: Date.now(), files };
    return files;
  } catch (err) {
    // Serve the last good copy past its TTL rather than failing the render.
    if (cache && cache.key === key) return cache.files;
    throw err;
  }
}

/** Resolve the active template source: the configured git repo, else the
 *  templates vendored with the module. Never throws. */
export async function loadTemplateSource(moduleTemplatesDir: string): Promise<TemplateSource> {
  const repo = parseTemplateRepoUrl(process.env.SPEAKER_CARDS_TEMPLATE_REPO);
  if (repo) {
    try {
      const files = await fetchRepoFiles(repo);
      return {
        origin: 'git',
        ref: `${repo.org}/${repo.repo}#${repo.ref}`,
        getFile: (path: string) => files.get(path) ?? null,
      };
    } catch (err) {
      console.warn(
        `[event-speakers] template repo unavailable (${err instanceof Error ? err.message : err}) — using vendored templates`,
      );
    }
  }
  // Vendored fallback: templates load from disk in templateLoader; there are
  // no repo files, so brand resolution yields the template defaults.
  return { origin: 'vendored', ref: null, getFile: () => null };
}

/** Template loader for renderSpeakerCards: repo file when present, vendored
 *  module file otherwise. */
export function templateLoader(source: TemplateSource, moduleTemplatesDir: string) {
  return async (fileName: string): Promise<string> => {
    if (source.origin === 'git') {
      const fromRepo = source.getFile(`templates/${fileName}`);
      if (fromRepo) return fromRepo.toString('utf8');
    }
    return readFile(join(moduleTemplatesDir, fileName), 'utf8');
  };
}

interface MappingRule {
  brand?: string;
  event_id?: string;
  event_slug_contains?: string;
  title_contains?: string;
  event_type?: string;
}

/** First-match-wins rule evaluation. All fields present on a rule must
 *  match; substring matches are case-insensitive. No regex on purpose
 *  (repo content must not be able to ReDoS the worker). */
export function resolveBrandKey(
  mapping: { default_brand?: string; rules?: MappingRule[] } | null,
  event: { event_id?: string | null; event_slug?: string | null; event_title?: string | null; event_type?: string | null },
): string | null {
  if (!mapping) return null;
  const title = (event.event_title ?? '').toLowerCase();
  const slug = (event.event_slug ?? '').toLowerCase();
  for (const rule of mapping.rules ?? []) {
    if (!rule?.brand) continue;
    let matched = false;
    if (rule.event_id !== undefined) {
      if (rule.event_id !== event.event_id) continue;
      matched = true;
    }
    if (rule.event_slug_contains !== undefined) {
      if (!slug.includes(String(rule.event_slug_contains).toLowerCase())) continue;
      matched = true;
    }
    if (rule.title_contains !== undefined) {
      if (!title.includes(String(rule.title_contains).toLowerCase())) continue;
      matched = true;
    }
    if (rule.event_type !== undefined) {
      if (rule.event_type !== event.event_type) continue;
      matched = true;
    }
    if (matched) return rule.brand;
  }
  return mapping.default_brand ?? null;
}

function parseJsonFile(source: TemplateSource, path: string): unknown | null {
  if (source.origin !== 'git') return null;
  const buf = source.getFile(path);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

/** Validate a brand definition from the repo into safe {{brand.*}} values:
 *  colors must be hex, the lockup becomes a data: URI. Anything invalid is
 *  dropped so the template's built-in Voice defaults apply. */
export function buildBrandVars(
  brand: Record<string, unknown> | null,
  lockupSvg: Buffer | null,
): BrandVars {
  const vars: BrandVars = {};
  if (!brand) return vars;
  for (const key of ['accent', 'accent_bright', 'accent_dark', 'wave_from'] as const) {
    const value = brand[key];
    if (typeof value === 'string' && HEX_COLOR_RE.test(value.trim())) vars[key] = value.trim();
  }
  if (lockupSvg && lockupSvg.length > 0 && lockupSvg.length <= 2 * 1024 * 1024) {
    vars.lockup_url = `data:image/svg+xml;base64,${lockupSvg.toString('base64')}`;
  }
  return vars;
}

/** Full event → brand-vars resolution against a loaded source. Returns {}
 *  (template defaults, Voice blue) when unmapped or on any repo problem. */
export function resolveBrandVars(
  source: TemplateSource,
  event: { event_id?: string | null; event_slug?: string | null; event_title?: string | null; event_type?: string | null },
): BrandVars {
  if (source.origin !== 'git') return {};
  const mapping = parseJsonFile(source, 'mapping.json');
  const key = resolveBrandKey(mapping, event);
  if (!key || !/^[\w-]{1,64}$/.test(key)) return {};
  const brand = parseJsonFile(source, `brands/${key}.json`);
  if (!brand || typeof brand !== 'object') return {};
  const lockupName = typeof brand.lockup === 'string' && /^[\w.-]{1,100}$/.test(brand.lockup) ? brand.lockup : null;
  const lockupSvg = lockupName ? source.getFile(`brands/${lockupName}`) : null;
  return buildBrandVars(brand, lockupSvg);
}
