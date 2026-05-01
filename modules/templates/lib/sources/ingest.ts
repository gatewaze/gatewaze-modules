/**
 * High-level ingest helpers for `kind='upload'` and `kind='inline'` sources.
 * Git ingest lands in PR 5 (separate spec) — its plumbing is more involved
 * because of the cloned working tree + drift monitor.
 *
 * The flow:
 *   ingestUpload  → writes the source row, parses the upload, calls applySource()
 *   ingestInline  → same shape, with the inline_html as the bytes
 *
 * Each function returns the source row's id and the apply result so callers
 * can surface "X added / Y bumped / Z unchanged" in the admin UI.
 */

import { createHash } from 'node:crypto';
import { parse } from '../parser/parse.js';
import { applySource, type ApplyResult, type ApplySupabaseClient } from './apply.js';

export interface IngestSupabaseClient extends ApplySupabaseClient {
  from(table: string): {
    insert(values: Record<string, unknown>): {
      select(cols: string): {
        single(): Promise<{ data: { id: string } | null; error: { message: string } | null }>;
      };
    };
    update(values: Record<string, unknown>): {
      eq(col: string, val: unknown): Promise<{ error: { message: string } | null }>;
    };
  };
}

export interface IngestResult {
  source_id: string;
  apply: ApplyResult;
}

export interface IngestUploadInput {
  library_id: string;
  label: string;
  /** Raw HTML contents of the uploaded file. */
  html: string;
  /** Object-storage path the original file was persisted at (sites_media or platform storage). */
  upload_blob_ref: string;
  created_by?: string | null;
}

export async function ingestUpload(
  supabase: IngestSupabaseClient,
  input: IngestUploadInput,
): Promise<IngestResult> {
  const sha = sha256Hex(input.html);

  // 1. Parse first; if errors, return early without creating a source row.
  //    (An author who uploads a malformed file should see errors; we don't
  //    want to leave half-created source rows around in that case.)
  const parsed = parse(input.html, { sourcePath: input.label });
  if (parsed.errors.length > 0) {
    return {
      source_id: '',
      apply: { artifacts: [], errors: parsed.errors.map(e => ({ code: e.code, message: e.message })), dryRun: false },
    };
  }

  // 2. Insert the source row.
  const insert = await supabase
    .from('templates_sources')
    .insert({
      library_id: input.library_id,
      kind: 'upload',
      label: input.label,
      status: 'active',
      upload_blob_ref: input.upload_blob_ref,
      upload_sha: sha,
      created_by: input.created_by ?? null,
    })
    .select('id')
    .single();

  if (insert.error || !insert.data) {
    return {
      source_id: '',
      apply: { artifacts: [], errors: [{ code: 'templates.ingest.source_insert_failed', message: insert.error?.message ?? 'unknown' }], dryRun: false },
    };
  }

  // 3. Apply the parse via the SQL RPC.
  const apply = await applySource(supabase, insert.data.id, parsed, { sourceSha: sha });

  return { source_id: insert.data.id, apply };
}

export interface IngestInlineInput {
  library_id: string;
  label: string;
  /** The pasted block / wrapper fragment HTML. */
  inline_html: string;
  created_by?: string | null;
}

export async function ingestInline(
  supabase: IngestSupabaseClient,
  input: IngestInlineInput,
): Promise<IngestResult> {
  const sha = sha256Hex(input.inline_html);
  const parsed = parse(input.inline_html, { sourcePath: input.label });
  if (parsed.errors.length > 0) {
    return {
      source_id: '',
      apply: { artifacts: [], errors: parsed.errors.map(e => ({ code: e.code, message: e.message })), dryRun: false },
    };
  }

  const insert = await supabase
    .from('templates_sources')
    .insert({
      library_id: input.library_id,
      kind: 'inline',
      label: input.label,
      status: 'active',
      inline_html: input.inline_html,
      inline_sha: sha,
      created_by: input.created_by ?? null,
    })
    .select('id')
    .single();

  if (insert.error || !insert.data) {
    return {
      source_id: '',
      apply: { artifacts: [], errors: [{ code: 'templates.ingest.source_insert_failed', message: insert.error?.message ?? 'unknown' }], dryRun: false },
    };
  }

  const apply = await applySource(supabase, insert.data.id, parsed, { sourceSha: sha });
  return { source_id: insert.data.id, apply };
}

/**
 * Re-apply an existing upload source from its persisted blob (for "force
 * re-import" admin actions). The caller is expected to fetch the blob from
 * object storage and hand the HTML in.
 */
export async function reapplyUpload(
  supabase: IngestSupabaseClient,
  sourceId: string,
  uploadHtml: string,
): Promise<ApplyResult> {
  const sha = sha256Hex(uploadHtml);
  const parsed = parse(uploadHtml, { sourcePath: 'reapply' });
  if (parsed.errors.length > 0) {
    return { artifacts: [], errors: parsed.errors.map(e => ({ code: e.code, message: e.message })), dryRun: false };
  }
  return applySource(supabase, sourceId, parsed, { sourceSha: sha });
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}
