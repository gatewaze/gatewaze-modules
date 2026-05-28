/**
 * URL normalization (spec §10.4).
 *
 * Applied before any check, idempotency lookup, or audit-log write.
 * Same rules apply to redirect-chain hops and to robots.txt origin keys
 * so cache lookups don't fragment between callers.
 */

import { Buffer } from 'node:buffer';
import type { NormalizedUrl } from './types.js';

export class InvalidUrlError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
    this.name = 'InvalidUrlError';
  }
}

const PUNYCODE_PREFIX = 'xn--';

/**
 * Lowercase + IDN→Punycode + trailing-dot strip + default-port strip
 * + fragment strip + repeated-`?` collapse.
 *
 * Throws InvalidUrlError on:
 *  - non-http(s) scheme
 *  - userinfo (RFC 3986 `username:password@host`) — rejected per §5.1
 *  - percent-encoded host
 *  - URL > 2048 chars
 *  - IPv6 host that doesn't parse
 */
export function parseAndNormalize(raw: string): NormalizedUrl {
  if (raw.length > 2048) {
    throw new InvalidUrlError('url exceeds 2048 chars', raw);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new InvalidUrlError('url cannot be parsed', raw);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidUrlError('url scheme must be http or https', raw);
  }

  if (parsed.username || parsed.password) {
    // §5.1: credentials in URLs would leak to logs/audit; we don't accept
    // them.
    throw new InvalidUrlError('url userinfo is not permitted', raw);
  }

  // WHATWG URL parser already rejects percent-encoded host octets in the
  // host position, so we just sanity-check the resulting hostname.
  if (!parsed.hostname) {
    throw new InvalidUrlError('url must include a host', raw);
  }

  // Lowercase host. WHATWG URL has already done IDN→Punycode for unicode
  // domain labels.
  let host = parsed.hostname.toLowerCase();

  // IPv6 literals come back from WHATWG with surrounding brackets; we
  // preserve them in `host` for matching consistency.
  // node's URL hostname strips brackets in older versions; we add them
  // back if the original had them.
  if (raw.includes('//[') && !host.startsWith('[')) {
    host = `[${host}]`;
  }

  // Strip trailing dot (DNS root) — `example.com.` and `example.com`
  // resolve to the same record.
  if (host.endsWith('.') && !host.startsWith('[')) {
    host = host.slice(0, -1);
  }

  const scheme = parsed.protocol === 'https:' ? 'https' : 'http';
  const defaultPort = scheme === 'https' ? 443 : 80;
  const port = parsed.port ? Number(parsed.port) : null;
  const portIsDefault = port === null || port === defaultPort;

  // Fragment is stripped (it never reaches the server anyway).
  // Path is left case-sensitive per RFC 3986.
  // Repeated '?' are collapsed by URL constructor; query string itself is
  // left as-is (we don't sort — would break sites that depend on order).
  const portSegment = portIsDefault ? '' : `:${port}`;
  const pathAndQuery = `${parsed.pathname}${parsed.search}`;

  return {
    href: `${scheme}://${host}${portSegment}${pathAndQuery}`,
    scheme,
    host,
    port: portIsDefault ? null : port,
    origin: `${scheme}://${host}${portSegment}`,
    path: parsed.pathname,
    search: parsed.search,
  };
}

/**
 * Canonical origin key for the robots cache (§8.1).
 * Lowercased scheme + host + non-default port. Always punycode.
 */
export function canonicalOrigin(u: NormalizedUrl): string {
  return u.origin;
}

/**
 * Apply query-parameter redaction matching `redactKeys` (case-insensitive).
 * Used for cross-tenant admin views and INFO-level logs (§11.3).
 *
 * The stored `audit_log.requested_url` is the RAW URL — redaction is
 * applied on the read path, not the write path.
 */
export function redactQueryParams(href: string, redactKeys: string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return href;
  }
  const lower = new Set(redactKeys.map(k => k.toLowerCase()));
  for (const [k] of parsed.searchParams) {
    if (lower.has(k.toLowerCase())) {
      parsed.searchParams.set(k, 'REDACTED');
    }
  }
  return parsed.toString();
}

/**
 * Build the canonical idempotency cache key (§10.5).
 *
 * Hash inputs:
 *   api_key_id || idempotency_key || canonical_request_body
 *   || domain_rules_version || robots_origin_version
 *
 * Returns a hex-encoded SHA-256 hash, prefixed for Redis namespacing.
 */
export function buildIdempotencyCacheKey(input: {
  apiKeyId: string;
  idempotencyKey: string;
  canonicalBody: string;
  domainRulesVersion: number;
  robotsOriginVersion: number;
}): string {
  // We can't use node:crypto type-import here because Vitest in this
  // repo runs without DOM types; deferred to runtime require.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto');
  const h = createHash('sha256');
  h.update(input.apiKeyId);
  h.update('\0');
  h.update(input.idempotencyKey);
  h.update('\0');
  h.update(input.canonicalBody);
  h.update('\0');
  h.update(String(input.domainRulesVersion));
  h.update('\0');
  h.update(String(input.robotsOriginVersion));
  return `gw-fetch:idem:${input.apiKeyId}:${(h.digest() as Buffer).toString('hex')}`;
}
