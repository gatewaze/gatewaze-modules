/**
 * MCP extension resolution — converts an `extensions[]` entry from a
 * parsed recipe into the args needed by `createMcpClient`:
 *
 *   1. `${GATEWAZE_*}` substitution in the URI (§4.9). Variables are
 *      resolved against the operator config; undefined vars are a
 *      hard refusal (spec maps this to feature='env-substitution').
 *   2. URL re-validation via the SSRF blocklist (substituted URLs
 *      could now point at internal hosts).
 *   3. Auth resolution (§4.8):
 *        - `auth.none`               → bearer_token: undefined
 *        - `auth.bearer.env_key: X`  → bearer_token: resolve(X)
 *        - `auth.bearer.use_case_credential: true` → bearer_token:
 *          looked up via the caller-supplied credential router.
 *
 * The caller (run-recipe.ts) handles the spec-required "refused
 * recipe" semantics when this helper returns `ok: false` —
 * specifically `feature: 'env-substitution'` for undefined vars.
 */

import { checkMcpUrlShape } from './mcp-ssrf.js';
import { resolveGatewazeEnvVar } from './operator-config.js';

/** Shape we expect on a parsed Tier-1 streamable_http extension. */
export interface StreamableHttpExtension {
  type: 'streamable_http';
  uri: string;
  auth?: {
    none?: boolean;
    bearer?: {
      env_key?: string;
      use_case_credential?: boolean;
    };
  };
  [key: string]: unknown;
}

export type UseCaseCredentialResolver = (provider: 'mcp', useCase: string) => Promise<string | null>;

export interface ResolveMcpResult {
  ok: true;
  uri: string;
  bearer_token?: string;
}

export interface ResolveMcpError {
  ok: false;
  /** Stable refusal key — surfaces verbatim in the executor's failure_reason. */
  reason:
    | 'env-substitution'
    | 'ssrf-substituted'
    | 'missing-auth-block'
    | 'invalid-env-key'
    | 'env-key-undefined'
    | 'use-case-credential-unavailable'
    | 'malformed-extension';
  details?: string;
}

/**
 * Resolve a parsed streamable_http extension to the args needed by
 * createMcpClient. Pure-async — does no IO except optionally calling
 * the supplied `resolveUseCaseCredential` closure.
 */
export async function resolveMcpExtension(
  ext: unknown,
  useCase: string,
  resolveUseCaseCredential?: UseCaseCredentialResolver,
): Promise<ResolveMcpResult | ResolveMcpError> {
  if (!ext || typeof ext !== 'object') {
    return { ok: false, reason: 'malformed-extension', details: 'extension must be an object' };
  }
  const e = ext as Record<string, unknown>;
  if (e.type !== 'streamable_http') {
    return { ok: false, reason: 'malformed-extension', details: `expected type=streamable_http, got ${String(e.type)}` };
  }
  if (typeof e.uri !== 'string' || e.uri.length === 0) {
    return { ok: false, reason: 'malformed-extension', details: 'uri must be a non-empty string' };
  }

  // ── URI substitution ────────────────────────────────────────────
  const substituted = substituteGatewazeVars(e.uri);
  if (!substituted.ok) {
    return { ok: false, reason: 'env-substitution', details: substituted.reason };
  }

  // ── Re-validate URL shape after substitution ────────────────────
  // checkMcpUrlShape catches obviously-bad URLs (loopback, non-
  // HTTPS, etc.) without doing DNS. The full DNS-resolution check
  // happens inside createMcpClient at connect time so it re-resolves
  // per HTTP connection per §7.5.
  const shape = checkMcpUrlShape(substituted.value);
  if (!shape.ok) {
    return {
      ok: false,
      reason: 'ssrf-substituted',
      details: `URL after substitution rejected: ${shape.reason}`,
    };
  }

  // ── Auth resolution ─────────────────────────────────────────────
  const auth = e.auth as StreamableHttpExtension['auth'];
  if (!auth) {
    return {
      ok: false,
      reason: 'missing-auth-block',
      details: 'recipe must declare auth: { none } / { bearer: { env_key } } / { bearer: { use_case_credential: true } }',
    };
  }
  if (auth.none) {
    return { ok: true, uri: substituted.value };
  }
  const bearer = auth.bearer;
  if (!bearer || typeof bearer !== 'object') {
    return {
      ok: false,
      reason: 'missing-auth-block',
      details: 'auth.bearer required when auth.none is absent',
    };
  }
  if (typeof bearer.env_key === 'string' && bearer.env_key.length > 0) {
    if (!/^GATEWAZE_[A-Z_]+$/.test(bearer.env_key)) {
      return {
        ok: false,
        reason: 'invalid-env-key',
        details: `auth.bearer.env_key '${bearer.env_key}' must match ^GATEWAZE_[A-Z_]+$`,
      };
    }
    const value = resolveGatewazeEnvVar(bearer.env_key);
    if (value == null) {
      return {
        ok: false,
        reason: 'env-key-undefined',
        details: `${bearer.env_key} not defined in operator config (config/ai-recipes.yaml: mcp_env)`,
      };
    }
    return { ok: true, uri: substituted.value, bearer_token: value };
  }
  if (bearer.use_case_credential === true) {
    if (!resolveUseCaseCredential) {
      return {
        ok: false,
        reason: 'use-case-credential-unavailable',
        details: 'caller did not supply a use-case credential resolver',
      };
    }
    const token = await resolveUseCaseCredential('mcp', useCase);
    if (!token) {
      return {
        ok: false,
        reason: 'use-case-credential-unavailable',
        details: `no MCP credential pinned for use_case '${useCase}'`,
      };
    }
    return { ok: true, uri: substituted.value, bearer_token: token };
  }
  return {
    ok: false,
    reason: 'missing-auth-block',
    details: 'auth.bearer must declare env_key or use_case_credential',
  };
}

/**
 * Substitute `${GATEWAZE_*}` references in a URI. Returns the
 * resolved URL or a refusal naming the first undefined variable.
 *
 * Only GATEWAZE_*-keyed substitution is supported — random shell-
 * style references like ${HOME} are deliberately rejected so authors
 * can't leak host env into recipe URIs.
 */
export function substituteGatewazeVars(
  template: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  // Find every ${...} reference. Anything that doesn't match
  // GATEWAZE_[A-Z_]+ is refused.
  const refRegex = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
  let out = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = refRegex.exec(template)) !== null) {
    out += template.slice(lastIndex, match.index);
    const name = match[1]!;
    if (!/^GATEWAZE_[A-Z_]+$/.test(name)) {
      return { ok: false, reason: `non_gatewaze_var: ${name}` };
    }
    const value = resolveGatewazeEnvVar(name);
    if (value == null) {
      return { ok: false, reason: `undefined_var: ${name}` };
    }
    out += value;
    lastIndex = refRegex.lastIndex;
  }
  out += template.slice(lastIndex);
  return { ok: true, value: out };
}
