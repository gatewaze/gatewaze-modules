/**
 * Compile a TypeScript content schema (Form A per spec-sites-theme-kinds §5.3)
 * to a JSON Schema usable by Ajv.
 *
 * **DEFERRED to a follow-up PR.** Per spec §5.4, the compilation MUST run
 * inside a sandboxed `worker_threads` subprocess with strict resource limits
 * (no network, read-only fs outside scratch dir, 1 CPU, 512 MB, 60s
 * wall-clock). It uses `ts-json-schema-generator` plus a JSDoc plugin that
 * forwards `@gatewazePersonalize` and `@gatewazeFormat` annotations as
 * `x-gatewaze-personalize` / `x-gatewaze-format` keywords on the produced
 * JSON Schema.
 *
 * Building this safely involves:
 *   1. Sandbox infra: worker_threads with --no-experimental-fetch, custom
 *      `resolve` hook restricting fs to the per-job scratch dir, ulimit
 *      (memory + CPU).
 *   2. ts-json-schema-generator dependency, pinned for reproducibility.
 *   3. A `@gatewaze/templates-schema-plugin` package for the JSDoc tag
 *      forwarder — ~50 lines but a separate npm package so it can be
 *      depended on by theme repos that want to compile their own schemas
 *      locally for type-checking parity.
 *   4. Tests covering: happy path, oversized schema, infinite-loop type
 *      construction (sandbox timeout), filesystem escape attempts, JSDoc
 *      tag forwarding.
 *
 * The Form B (hand-authored JSON Schema) path doesn't need any of this —
 * just a JSON parse + Ajv compile. That's already exercised in the
 * validator (`./validate.ts`).
 *
 * Until the sandboxed compiler lands, themes using Form A should
 * pre-compile their schema and check `content/schema.json` into the repo;
 * the platform validates and ingests that directly.
 */

import type { ContentSchemaFormat } from '../../types/index.js';

export interface CompileTsSchemaInput {
  /** The repo's scratch dir (per-job; the worker cleans this up). */
  scratchDir: string;
  /** Path to schema.ts relative to repo root (per theme.json.schema.path). */
  schemaPath: string;
  /** Exported interface name to compile (per theme.json.schema.exported_name). */
  exportedName: string;
  /** Path to the tsconfig.json to use for compilation; null = use built-in default. */
  tsconfigPath: string | null;
}

export interface CompileTsSchemaResult {
  schema: Record<string, unknown>;
  /** SHA-256 hex of the canonical JSON Schema (for drift detection). */
  schemaHash: string;
}

export async function compileTsSchema(_input: CompileTsSchemaInput): Promise<CompileTsSchemaResult> {
  throw new Error(
    'templates: TS schema compilation is not implemented in v0.1. Themes using Form A should pre-compile schema.ts to schema.json and commit the JSON. See lib/content-schemas/compile-ts.ts for the deferred design and spec-sites-theme-kinds §5.4 for the sandbox requirements.',
  );
}

/**
 * Resolved compiler options for the built-in default. Per spec §5.2 the
 * default is intentionally minimal and JSX-aware so schema.ts can
 * `import type` from JSX-using sibling files. Theme authors with non-trivial
 * type setups should declare their own `compiler_options_path` rather than
 * rely on this fallback.
 */
export const DEFAULT_TS_COMPILER_OPTIONS = {
  target: 'ES2022',
  module: 'ESNext',
  moduleResolution: 'Bundler',
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  forceConsistentCasingInFileNames: true,
  isolatedModules: true,
  noEmit: true,
  jsx: 'preserve',
  lib: ['ES2022'],
} as const;

/**
 * Decide which compilation entry point applies for a given source.
 * Pure decision; the caller dispatches accordingly.
 */
export function pickCompileStrategy(format: ContentSchemaFormat): 'parse-json' | 'compile-ts' {
  return format === 'json' ? 'parse-json' : 'compile-ts';
}
