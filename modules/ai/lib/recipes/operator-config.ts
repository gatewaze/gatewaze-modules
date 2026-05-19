/**
 * Operator-controlled recipe runtime config.
 *
 * Per spec-ai-workflows-and-skill-interop.md §4.3 + §4.9, the
 * operator owns two surfaces that recipe authors cannot touch:
 *
 *   1. `stdio_allowlist` — the set of `cmd:` strings that Tier-2
 *      `stdio` MCP extensions may invoke. Authors who declare an
 *      arbitrary command are refused at parse time.
 *   2. `mcp_env` — the `GATEWAZE_*` variable map used to substitute
 *      values into `streamable_http` URIs + auth bearer env_keys.
 *      `mcp_env_passthrough: true` opts in to host-process env as a
 *      secondary fallback; off by default to prevent leaking
 *      arbitrary env vars into recipes.
 *
 * Source: `config/ai-recipes.yaml` resolved from one of:
 *   - $AI_RECIPES_CONFIG_PATH (absolute, when set)
 *   - $GATEWAZE_CONFIG_DIR/ai-recipes.yaml
 *   - /etc/gatewaze/ai-recipes.yaml
 *   - <repo-root>/config/ai-recipes.yaml  (dev fallback)
 *
 * Missing config is fine and means an empty allowlist / no env map.
 * Parse errors are logged and the loader returns empty config — we
 * don't want a typo in operator YAML to wedge the runner.
 *
 * The loader is cached per-process (the config rarely changes; ops
 * restart the API to pick up changes). A `reloadOperatorConfig()`
 * escape hatch exists for tests + the future admin reload endpoint.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load as loadYaml, YAMLException } from 'js-yaml';

export interface OperatorRecipeConfig {
  /** Allowed `cmd:` values for `stdio` MCP extensions (Tier-2 gate). */
  stdio_allowlist: string[];
  /** Per-binary env mapping for stdio extensions. */
  stdio_env: Record<string, Record<string, string>>;
  /** GATEWAZE_* substitution map for streamable_http URLs + auth env_keys. */
  mcp_env: Record<string, string>;
  /**
   * When true, host process env is consulted as a fallback for
   * GATEWAZE_* variables. False by default — prevents leakage of
   * unrelated env vars into recipe surfaces.
   */
  mcp_env_passthrough: boolean;
  /** Path the config was loaded from (null when no file found). */
  loaded_from: string | null;
}

const ENV_KEY_REGEX = /^GATEWAZE_[A-Z_]+$/;

let cached: OperatorRecipeConfig | null = null;

export function getOperatorConfig(): OperatorRecipeConfig {
  if (cached) return cached;
  cached = loadOperatorConfig();
  return cached;
}

/** Force a reload — used by tests and (eventually) an admin endpoint. */
export function reloadOperatorConfig(): OperatorRecipeConfig {
  cached = loadOperatorConfig();
  return cached;
}

function loadOperatorConfig(): OperatorRecipeConfig {
  const candidatePaths = candidateConfigPaths();
  for (const p of candidatePaths) {
    if (!existsSync(p)) continue;
    let raw: string;
    try {
      raw = readFileSync(p, 'utf-8');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[ai-recipes] operator-config read failed for ${p}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = loadYaml(raw);
    } catch (err) {
      const msg = err instanceof YAMLException ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[ai-recipes] operator-config parse failed for ${p}: ${msg} — using empty config`);
      return empty(p);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // eslint-disable-next-line no-console
      console.warn(`[ai-recipes] operator-config ${p} root must be a mapping — using empty config`);
      return empty(p);
    }
    return normalise(parsed as Record<string, unknown>, p);
  }
  return empty(null);
}

function candidateConfigPaths(): string[] {
  const paths: string[] = [];
  const envPath = process.env.AI_RECIPES_CONFIG_PATH;
  if (envPath && envPath.length > 0) paths.push(envPath);
  const dirEnv = process.env.GATEWAZE_CONFIG_DIR;
  if (dirEnv && dirEnv.length > 0) paths.push(resolve(dirEnv, 'ai-recipes.yaml'));
  paths.push('/etc/gatewaze/ai-recipes.yaml');
  // Dev fallback — walks up from the module's working dir. Best-
  // effort: process.cwd() in dev is usually the repo root.
  paths.push(resolve(process.cwd(), 'config/ai-recipes.yaml'));
  return paths;
}

function normalise(doc: Record<string, unknown>, loadedFrom: string): OperatorRecipeConfig {
  // Defensive parsing — any field-level issue logs + falls back, never
  // throws. The point of operator config is to be tolerant of typos at
  // runtime; the alternative (refuse to boot) is operationally hostile.

  // stdio_allowlist
  const stdioAllowlist: string[] = [];
  if (Array.isArray(doc.stdio_allowlist)) {
    for (const entry of doc.stdio_allowlist) {
      if (typeof entry === 'string' && entry.length > 0 && entry.length < 1024) {
        stdioAllowlist.push(entry);
      }
    }
  }

  // stdio_env: per-binary env mapping
  const stdioEnv: Record<string, Record<string, string>> = {};
  if (doc.stdio_env && typeof doc.stdio_env === 'object' && !Array.isArray(doc.stdio_env)) {
    for (const [bin, val] of Object.entries(doc.stdio_env as Record<string, unknown>)) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
      const m: Record<string, string> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (typeof v === 'string') m[k] = v;
      }
      stdioEnv[bin] = m;
    }
  }

  // mcp_env — GATEWAZE_*-keyed map.
  const mcpEnv: Record<string, string> = {};
  if (doc.mcp_env && typeof doc.mcp_env === 'object' && !Array.isArray(doc.mcp_env)) {
    for (const [k, v] of Object.entries(doc.mcp_env as Record<string, unknown>)) {
      if (typeof v !== 'string') continue;
      if (!ENV_KEY_REGEX.test(k)) {
        // eslint-disable-next-line no-console
        console.warn(`[ai-recipes] operator-config.mcp_env: '${k}' does not match GATEWAZE_[A-Z_]+ — skipped`);
        continue;
      }
      mcpEnv[k] = v;
    }
  }

  const passthrough = doc.mcp_env_passthrough === true;

  return {
    stdio_allowlist: stdioAllowlist,
    stdio_env: stdioEnv,
    mcp_env: mcpEnv,
    mcp_env_passthrough: passthrough,
    loaded_from: loadedFrom,
  };
}

function empty(loadedFrom: string | null): OperatorRecipeConfig {
  return {
    stdio_allowlist: [],
    stdio_env: {},
    mcp_env: {},
    mcp_env_passthrough: false,
    loaded_from: loadedFrom,
  };
}

/**
 * Resolve a GATEWAZE_* variable using the operator config + optional
 * passthrough. Returns null when undefined — the caller decides
 * whether the absence is a refuse (substitution) or a soft default
 * (auth resolution chain).
 */
export function resolveGatewazeEnvVar(name: string): string | null {
  if (!ENV_KEY_REGEX.test(name)) return null;
  const cfg = getOperatorConfig();
  const v = cfg.mcp_env[name];
  if (typeof v === 'string') return v;
  if (cfg.mcp_env_passthrough) {
    const fromHost = process.env[name];
    if (typeof fromHost === 'string' && fromHost.length > 0) return fromHost;
  }
  return null;
}
