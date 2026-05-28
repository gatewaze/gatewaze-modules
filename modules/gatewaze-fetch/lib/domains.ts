/**
 * Domain governance — three-layer model (spec §7).
 *
 *   1. Instance denylist  — operator-managed, instance-wide. Always blocked.
 *   2. Instance allowlist — operator-managed. If non-empty, host must match.
 *   3. Per-key rules      — denylist takes precedence over allowlist.
 *
 * Evaluation runs twice per request: pre-fetch on the requested URL host,
 * post-fetch on the final URL host (catches redirect-bypass attacks).
 */

import type { BlockedBy, DomainDecision } from './types.js';

const ALLOW: DomainDecision = { ok: true };

export interface DomainRulesSnapshot {
  instanceDeny: string[];
  instanceAllow: string[];
  keyDeny: string[];
  keyAllow: string[];
}

/**
 * Evaluate a host against the layered ruleset. Host MUST be normalized
 * (§10.4) before being passed in.
 */
export function evaluateHost(
  host: string,
  rules: DomainRulesSnapshot,
): DomainDecision {
  const matches = (patterns: string[]): string | null => {
    for (const p of patterns) {
      if (matchPattern(host, p)) return p;
    }
    return null;
  };

  let m = matches(rules.instanceDeny);
  if (m) return blocked('instance_denylist', m);

  if (rules.instanceAllow.length > 0 && !matches(rules.instanceAllow)) {
    return blocked('instance_allowlist_violation', '<no match>');
  }

  m = matches(rules.keyDeny);
  if (m) return blocked('key_denylist', m);

  if (rules.keyAllow.length > 0 && !matches(rules.keyAllow)) {
    return blocked('key_allowlist_violation', '<no match>');
  }

  return ALLOW;
}

function blocked(rule: BlockedBy, pattern: string): DomainDecision {
  return { ok: false, rule, pattern };
}

/**
 * Match a host against a domain-glob pattern (spec §7.2).
 *
 * Supported syntax:
 *   exact:           example.com
 *   subdomain only:  *.example.com    (does NOT match bare example.com)
 *   suffix and self: **.example.com   (matches example.com OR any subdomain)
 *   IP literal:      10.0.0.1   or   [::1]
 *
 * Matching is case-insensitive. Both inputs SHOULD already be lowercased
 * by the caller; we lowercase defensively.
 */
export function matchPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();

  // Exact match (covers IP literals and bracketed IPv6)
  if (h === p) return true;

  // Subdomain wildcard
  if (p.startsWith('*.') && !p.startsWith('**.')) {
    const suffix = p.slice(2);
    if (h.endsWith(`.${suffix}`)) return true;
    return false;
  }

  // Suffix-and-self
  if (p.startsWith('**.')) {
    const suffix = p.slice(3);
    return h === suffix || h.endsWith(`.${suffix}`);
  }

  return false;
}
