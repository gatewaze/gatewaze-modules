/**
 * Robots.txt cache + enforcement (spec §8).
 *
 * - Cache stores RAW response body, not parsed rules — UA-dependent
 *   rule selection is recomputed per request from the cached body
 *   (UAs vary by caller §8.3).
 * - Cache key: scheme-specific origin (per RFC 9309 §2.3).
 * - Every robots evaluation outcome writes/upserts a cache row so the
 *   robots_origin_version (cache row's fetched_at) is stable for
 *   idempotency keys (§8.2).
 * - Permissive default on transient failures (5xx, parse error,
 *   timeout) — flippable via robots_strict_on_5xx.
 */

import type { DbClient } from './audit.js';
import type { ModuleSettings, NormalizedUrl, RobotsCheckResult } from './types.js';

export interface RobotsContext {
  db: DbClient;
  settings: ModuleSettings;
  /**
   * Caller-supplied UA-aware fetcher of robots.txt. We don't fetch
   * directly — the §0.1 invariant says all egress goes via
   * scrapling-fetcher.
   *
   * Should call scrapling-fetcher with mode='fast', proxy='never',
   * timeout 5s, and return the raw status + body (truncated to
   * 64 KiB).
   */
  fetchRobots: (origin: string) => Promise<{
    status: number;
    body: string;
    error?: string;
  }>;
}

/**
 * Evaluate whether the requested URL is allowed by robots.txt for the
 * given user-agent. Returns ok=true on permissive outcomes (5xx, parse
 * error) unless `robots_strict_on_5xx` is set.
 */
export async function evaluateRobots(
  url: NormalizedUrl,
  userAgent: string,
  ctx: RobotsContext,
): Promise<RobotsCheckResult> {
  const origin = url.origin;
  const cached = await readCache(ctx.db, origin);
  let body: string | null = null;
  let permissive = false;

  const ttlMs = ctx.settings.robots_cache_ttl_hours * 3_600_000;
  const now = Date.now();

  if (cached && new Date(cached.expires_at).getTime() > now) {
    body = cached.body;
    if (cached.parse_error) permissive = !ctx.settings.robots_strict_on_5xx;
    if (cached.status >= 500 || cached.status === 0) {
      permissive = !ctx.settings.robots_strict_on_5xx;
    }
  } else {
    // Cache miss — fetch via scrapling-fetcher.
    const res = await ctx.fetchRobots(origin);
    if (res.status === 200 && res.body) {
      body = res.body.slice(0, 65_536);
      await writeCache(ctx.db, origin, res.status, body, null, ttlMs);
    } else if (res.status === 200) {
      // Empty body → all allowed (RFC 9309 §2.2.4).
      body = '';
      await writeCache(ctx.db, origin, 200, '', null, ttlMs);
    } else if (res.status === 404 || res.status === 410) {
      body = ''; // all allowed
      await writeCache(ctx.db, origin, res.status, '', null, ttlMs);
    } else {
      // 5xx, timeout, parse error, etc. — permissive default; cached
      // for 5 minutes only so we re-check soon.
      permissive = !ctx.settings.robots_strict_on_5xx;
      await writeCache(
        ctx.db,
        origin,
        res.status,
        '',
        res.error ?? `status ${res.status}`,
        5 * 60_000,
      );
    }
  }

  if (permissive) return { ok: true };

  if (body === null || body === '') return { ok: true };

  // Parse + evaluate.
  try {
    const rule = matchRobotsRule(body, userAgent, url.path);
    if (rule.allow) return { ok: true };
    return {
      ok: false,
      disallowed_by: rule.line ?? '<unknown>',
      user_agent: userAgent,
      robots_url: `${origin}/robots.txt`,
    };
  } catch {
    // Parser threw — permissive (matches §8.2 parse-error policy).
    return { ok: true };
  }
}

interface CacheRow {
  origin: string;
  fetched_at: string;
  expires_at: string;
  status: number;
  body: string;
  parse_error: string | null;
}

async function readCache(db: DbClient, origin: string): Promise<CacheRow | null> {
  const r = await db.query(
    `select origin, fetched_at, expires_at, status, body, parse_error
       from fetch.robots_cache where origin = $1`,
    [origin],
  );
  return (r.rows[0] as CacheRow | undefined) ?? null;
}

async function writeCache(
  db: DbClient,
  origin: string,
  status: number,
  body: string,
  parseError: string | null,
  ttlMs: number,
): Promise<void> {
  const now = new Date();
  const expires = new Date(now.getTime() + ttlMs);
  await db.query(
    `insert into fetch.robots_cache (origin, fetched_at, expires_at, status, body, parse_error)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (origin) do update set
       fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at,
       status     = excluded.status,
       body       = excluded.body,
       parse_error = excluded.parse_error`,
    [origin, now, expires, status, body, parseError],
  );
}

/**
 * Read the version stamp (fetched_at as ms epoch) used in the
 * idempotency cache key (§10.5). Returns 0 when no cache row exists
 * yet — caller treats 0 as "no version" and proceeds.
 */
export async function getOriginVersion(db: DbClient, origin: string): Promise<number> {
  const r = await db.query(
    `select extract(epoch from fetched_at)::bigint as v
       from fetch.robots_cache where origin = $1`,
    [origin],
  );
  const row = r.rows[0] as { v: number } | undefined;
  return row?.v ?? 0;
}

// ---------------------------------------------------------------- parser
// Minimal RFC 9309 robots.txt evaluator. Supports User-agent, Allow,
// Disallow, and the "longest match wins" rule. We match the configured
// UA against group records: exact match wins; otherwise `*` is used.

interface RuleMatchResult {
  allow: boolean;
  line: string | null;
}

export function matchRobotsRule(
  robotsBody: string,
  userAgent: string,
  path: string,
): RuleMatchResult {
  const groups = parseGroups(robotsBody);
  const ua = userAgent.toLowerCase();

  // Find the matching group: exact UA token wins; otherwise '*'.
  let group = groups.find(g =>
    g.userAgents.some(u => ua.includes(u.toLowerCase())),
  );
  if (!group) group = groups.find(g => g.userAgents.includes('*'));
  if (!group) return { allow: true, line: null };

  // Longest-prefix match on Allow/Disallow rules; on tie, Allow wins.
  let bestAllow: { len: number; line: string } | null = null;
  let bestDisallow: { len: number; line: string } | null = null;
  for (const r of group.rules) {
    if (matchPath(r.value, path)) {
      const m = { len: r.value.length, line: `${r.kind}: ${r.value}` };
      if (r.kind === 'Allow') {
        if (!bestAllow || m.len > bestAllow.len) bestAllow = m;
      } else {
        if (!bestDisallow || m.len > bestDisallow.len) bestDisallow = m;
      }
    }
  }
  if (bestAllow && bestDisallow) {
    return bestAllow.len >= bestDisallow.len
      ? { allow: true, line: bestAllow.line }
      : { allow: false, line: bestDisallow.line };
  }
  if (bestDisallow) return { allow: false, line: bestDisallow.line };
  return { allow: true, line: bestAllow?.line ?? null };
}

interface RobotsGroup {
  userAgents: string[];
  rules: { kind: 'Allow' | 'Disallow'; value: string }[];
}

function parseGroups(body: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let inUaBlock = false; // run of consecutive User-agent lines starts a new group

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!inUaBlock) {
        current = { userAgents: [], rules: [] };
        groups.push(current);
        inUaBlock = true;
      }
      current!.userAgents.push(value);
    } else if (field === 'allow' || field === 'disallow') {
      inUaBlock = false;
      if (current) {
        current.rules.push({
          kind: field === 'allow' ? 'Allow' : 'Disallow',
          value,
        });
      }
    } else {
      // sitemap, crawl-delay, etc. — ignored; doesn't end UA block per
      // some interpretations, but we're permissive
      inUaBlock = false;
    }
  }
  return groups;
}

function matchPath(rule: string, path: string): boolean {
  if (rule === '') return false; // empty Disallow == allow nothing == match nothing
  // RFC 9309 wildcards: '*' = any sequence, '$' = end-anchor.
  if (rule.includes('*') || rule.endsWith('$')) {
    const re = new RegExp(
      '^' +
        rule
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\\\$$/, '$'),
    );
    return re.test(path);
  }
  return path.startsWith(rule);
}
