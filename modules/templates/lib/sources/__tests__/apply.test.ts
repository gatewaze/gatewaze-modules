import { describe, expect, it } from 'vitest';
import { applySource } from '../apply.js';
import { ingestUpload, ingestInline } from '../ingest.js';
import type { ParseResult } from '../../../types/index.js';

/**
 * Fake supabase client. Records the rpc/from calls so tests can assert
 * on the arguments without a live DB.
 */
function makeFakeSupabase(opts: {
  rpcResponse?: unknown;
  rpcError?: { message: string } | null;
  insertId?: string;
  insertError?: { message: string } | null;
} = {}) {
  const calls: { kind: string; payload: unknown }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ kind: 'rpc:' + fn, payload: args });
      return { data: opts.rpcResponse ?? { artifacts: [], errors: [] }, error: opts.rpcError ?? null };
    },
    from: (table: string) => ({
      insert: (values: Record<string, unknown>) => ({
        select: (cols: string) => ({
          single: async () => {
            calls.push({ kind: 'insert:' + table, payload: { values, cols } });
            return {
              data: opts.insertId ? { id: opts.insertId } : null,
              error: opts.insertError ?? null,
            };
          },
        }),
      }),
      update: (values: Record<string, unknown>) => ({
        eq: async (col: string, val: unknown) => {
          calls.push({ kind: 'update:' + table, payload: { values, col, val } });
          return { error: null };
        },
      }),
    }),
  };
  return { client, calls };
}

const trivialParseResult: ParseResult = {
  wrappers: [],
  block_defs: [
    {
      key: 'hero',
      name: 'Hero',
      description: 'A hero',
      has_bricks: false,
      sort_order: 0,
      schema: { type: 'object' },
      html: '<h1>{{title}}</h1>',
      rich_text_template: null,
      data_source: null,
      bricks: [],
    },
  ],
  definitions: [],
  errors: [],
  warnings: [],
};

describe('applySource()', () => {
  it('calls templates_apply_source RPC with the right shape', async () => {
    const { client, calls } = makeFakeSupabase({
      rpcResponse: {
        artifacts: [
          { artifact_kind: 'block_def', key: 'hero', action: 'added', artifact_id: 'block-uuid-1' },
        ],
        errors: [],
      },
    });
    const result = await applySource(client, 'src-uuid', trivialParseResult, {
      sourceSha: 'a'.repeat(64),
    });
    expect(result.errors).toEqual([]);
    expect(result.dryRun).toBe(false);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.action).toBe('added');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe('rpc:templates_apply_source');
    const payload = calls[0]?.payload as { p_source_id: string; p_source_sha: string; p_dry_run: boolean };
    expect(payload.p_source_id).toBe('src-uuid');
    expect(payload.p_source_sha).toBe('a'.repeat(64));
    expect(payload.p_dry_run).toBe(false);
  });

  it('returns parse errors without calling the RPC when ParseResult has errors', async () => {
    const { client, calls } = makeFakeSupabase();
    const errored: ParseResult = {
      ...trivialParseResult,
      errors: [{ code: 'templates.parse.block_unclosed', message: 'oops', path: null, line: 1 }],
    };
    const result = await applySource(client, 'src-uuid', errored, { sourceSha: 'x'.repeat(64) });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('templates.parse.block_unclosed');
    expect(calls).toHaveLength(0);
  });

  it('surfaces RPC errors as templates.apply.rpc_failed', async () => {
    const { client } = makeFakeSupabase({ rpcError: { message: 'boom' } });
    const result = await applySource(client, 'src-uuid', trivialParseResult, { sourceSha: 'b'.repeat(64) });
    expect(result.errors[0]?.code).toBe('templates.apply.rpc_failed');
    expect(result.errors[0]?.message).toBe('boom');
  });

  it('passes dryRun through to the RPC', async () => {
    const { client, calls } = makeFakeSupabase({ rpcResponse: { artifacts: [], errors: [] } });
    await applySource(client, 'src', trivialParseResult, { sourceSha: 'c'.repeat(64), dryRun: true });
    const payload = calls[0]?.payload as { p_dry_run: boolean };
    expect(payload.p_dry_run).toBe(true);
  });
});

describe('ingestUpload()', () => {
  it('parses the input, inserts the source row, and applies', async () => {
    const { client, calls } = makeFakeSupabase({
      insertId: 'new-source-uuid',
      rpcResponse: { artifacts: [{ artifact_kind: 'block_def', key: 'hero', action: 'added' }], errors: [] },
    });
    const html = `<!-- BLOCK:hero --><!-- SCHEMA:{} --><h1>{{title}}</h1><!-- /BLOCK:hero -->`;
    const result = await ingestUpload(client, {
      library_id: 'lib-uuid',
      label: 'hero.html',
      html,
      upload_blob_ref: 's3://bucket/key',
    });

    expect(result.source_id).toBe('new-source-uuid');
    expect(result.apply.errors).toEqual([]);
    expect(result.apply.artifacts).toHaveLength(1);

    const insertCall = calls.find((c) => c.kind === 'insert:templates_sources');
    expect(insertCall).toBeDefined();
    const insertPayload = insertCall?.payload as { values: Record<string, unknown> };
    expect(insertPayload.values['kind']).toBe('upload');
    expect(insertPayload.values['library_id']).toBe('lib-uuid');
    expect(insertPayload.values['upload_blob_ref']).toBe('s3://bucket/key');
    expect(typeof insertPayload.values['upload_sha']).toBe('string');
    expect((insertPayload.values['upload_sha'] as string).length).toBe(64);
  });

  it('refuses to insert a source row when the parse has errors', async () => {
    const { client, calls } = makeFakeSupabase({});
    const html = `<!-- BLOCK:bad --><!-- SCHEMA:{not valid json} --><h1></h1><!-- /BLOCK:bad -->`;
    const result = await ingestUpload(client, {
      library_id: 'lib',
      label: 'bad.html',
      html,
      upload_blob_ref: 's3://bucket/k',
    });

    expect(result.source_id).toBe('');
    expect(result.apply.errors.length).toBeGreaterThan(0);
    // No DB writes attempted.
    expect(calls.find((c) => c.kind === 'insert:templates_sources')).toBeUndefined();
    expect(calls.find((c) => c.kind.startsWith('rpc:'))).toBeUndefined();
  });
});

describe('ingestInline()', () => {
  it('inserts a kind=inline source with the html stored verbatim', async () => {
    const { client, calls } = makeFakeSupabase({
      insertId: 'inline-source-uuid',
      rpcResponse: { artifacts: [], errors: [] },
    });
    const html = `<!-- BLOCK:hero --><!-- SCHEMA:{} --><h1>x</h1><!-- /BLOCK:hero -->`;
    const result = await ingestInline(client, {
      library_id: 'lib',
      label: 'paste',
      inline_html: html,
    });
    expect(result.source_id).toBe('inline-source-uuid');
    const insert = calls.find((c) => c.kind === 'insert:templates_sources');
    const payload = insert?.payload as { values: Record<string, unknown> };
    expect(payload.values['kind']).toBe('inline');
    expect(payload.values['inline_html']).toBe(html);
    expect((payload.values['inline_sha'] as string).length).toBe(64);
  });
});
