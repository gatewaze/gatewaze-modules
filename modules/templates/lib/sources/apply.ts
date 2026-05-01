/**
 * apply() — given a ParseResult and a source row, persist definitions,
 * wrappers, blocks, and bricks. Updates is_current flags, manages
 * source_artifacts cross-references, computes a change preview if requested.
 *
 * Transactional via a single Supabase RPC (`templates.apply_source`) defined
 * in migration 006. The TypeScript here is the client; the SQL function is
 * authoritative and atomic.
 *
 * Why an RPC and not a chain of supabase.from(...).insert() calls:
 *   - Cross-table consistency (block_def + brick_defs + source_artifacts)
 *     must roll back together on error.
 *   - is_current flag flipping per (library_id, key) is a critical
 *     invariant; doing it client-side risks leaving two rows current.
 *   - Single round trip. Source applies are mostly small (< 50 artifacts).
 */

import type { ParseResult } from '../../types/index.js';

export interface ApplyOptions {
  /** Compute a change preview without persisting. Used for the `Review changes` UI. */
  dryRun?: boolean;
  /**
   * SHA of the parsed content. For git sources: the commit SHA.
   * For uploads: the SHA-256 of the file contents.
   * For inline: SHA-256 of the inline_html.
   */
  sourceSha: string;
}

export interface ApplyResult {
  /**
   * Per-artifact action taken (or planned, when dryRun=true):
   *   added    — first time this (library_id, key) row exists
   *   bumped   — new version row created; previous version's is_current flipped to false
   *   unchanged — content matches the current version exactly; no rows written
   *   detached — artifact was previously linked to this source but is no longer in the parse output
   */
  artifacts: ReadonlyArray<{
    artifact_kind: 'definition' | 'wrapper' | 'block_def' | 'brick_def';
    key: string;
    action: 'added' | 'bumped' | 'unchanged' | 'detached';
    artifact_id?: string;
  }>;
  errors: ReadonlyArray<{ code: string; message: string }>;
  /** True when `dryRun` was passed; nothing was persisted. */
  dryRun: boolean;
}

/**
 * Minimal Supabase client surface this function depends on. Kept
 * narrow to ease unit-testing with a fake client.
 */
export interface ApplySupabaseClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

export async function applySource(
  supabase: ApplySupabaseClient,
  sourceId: string,
  parseResult: ParseResult,
  opts: ApplyOptions,
): Promise<ApplyResult> {
  const { dryRun = false, sourceSha } = opts;

  if (parseResult.errors.length > 0) {
    return {
      artifacts: [],
      errors: parseResult.errors.map((e) => ({ code: e.code, message: e.message })),
      dryRun,
    };
  }

  // Build the payload the SQL function expects. The function signature is:
  //   templates.apply_source(
  //     p_source_id uuid, p_source_sha text,
  //     p_wrappers jsonb, p_block_defs jsonb, p_definitions jsonb,
  //     p_dry_run boolean
  //   ) RETURNS jsonb
  // The SQL function returns the apply-result shape directly.

  const { data, error } = await supabase.rpc('templates_apply_source', {
    p_source_id: sourceId,
    p_source_sha: sourceSha,
    p_wrappers: serialiseWrappers(parseResult),
    p_block_defs: serialiseBlocks(parseResult),
    p_definitions: serialiseDefinitions(parseResult),
    p_dry_run: dryRun,
  });

  if (error) {
    return {
      artifacts: [],
      errors: [{ code: 'templates.apply.rpc_failed', message: error.message }],
      dryRun,
    };
  }

  if (!data || typeof data !== 'object') {
    return {
      artifacts: [],
      errors: [{ code: 'templates.apply.rpc_unexpected_shape', message: 'apply_source returned non-object' }],
      dryRun,
    };
  }

  const d = data as { artifacts?: unknown; errors?: unknown };
  return {
    artifacts: Array.isArray(d.artifacts) ? (d.artifacts as ApplyResult['artifacts']) : [],
    errors: Array.isArray(d.errors) ? (d.errors as ApplyResult['errors']) : [],
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Serialisers — convert the parser's TS shapes into the JSON payloads the
// SQL function consumes. Kept inline (rather than a shared helper) so the
// shape is visible at the call site.
// ---------------------------------------------------------------------------

function serialiseWrappers(p: ParseResult): unknown {
  return p.wrappers.map((w) => ({
    key: w.key,
    name: w.name,
    html: w.html,
    meta_block_keys: w.meta_block_keys,
    global_seed_blocks: w.global_seed_blocks,
  }));
}

function serialiseBlocks(p: ParseResult): unknown {
  return p.block_defs.map((b) => ({
    key: b.key,
    name: b.name,
    description: b.description,
    has_bricks: b.has_bricks,
    sort_order: b.sort_order,
    schema: b.schema,
    html: b.html,
    rich_text_template: b.rich_text_template,
    data_source: b.data_source,
    bricks: b.bricks.map((br) => ({
      key: br.key,
      name: br.name,
      sort_order: br.sort_order,
      schema: br.schema,
      html: br.html,
      rich_text_template: br.rich_text_template,
    })),
  }));
}

function serialiseDefinitions(p: ParseResult): unknown {
  return p.definitions.map((d) => ({
    key: d.key,
    name: d.name,
    source_html: d.source_html,
    parsed_blocks: d.parsed_blocks,
    default_block_order: d.default_block_order,
    meta_block_keys: d.meta_block_keys,
  }));
}
