/**
 * Batch content endpoint validators (per spec-sites-theme-kinds §7.4).
 *
 * The Site Editor for theme_kind='website' sites saves drafts via a single
 * batch endpoint:
 *
 *   POST /api/modules/sites/admin/sites/:siteSlug/content:batch
 *   { drafts: [{ route, content, schemaVersion, baseCommitSha? }, ...] }
 *
 * Reasons we use a single batch call instead of N individual saves:
 *   - Editor opens N tabs / pages; saving them one at a time would be N
 *     round-trips and N concurrent writes against pages_nextjs_drafts.
 *   - One DB transaction means partial successes don't leak.
 *   - Per spec §7.4, validate ALL drafts up-front and reject the whole
 *     batch if any one fails. This keeps the save semantics
 *     all-or-nothing from the editor's POV.
 *
 * Validation is split: pure-shape checks (here) + schema-conformance and
 * personalization checks (delegated to the templates module's validator,
 * passed in via the `validateContent` dep).
 */

import { normalizeRoute } from '../page-lifecycle/route-validation.js';

export const MAX_BATCH_SIZE = 50;
export const MAX_CONTENT_BYTES_PER_DRAFT = 256 * 1024; // 256 KiB

export interface BatchDraftInput {
  route: string;
  content: Record<string, unknown>;
  schemaVersion: number;
  baseCommitSha?: string | null;
}

export interface BatchDraftNormalized {
  route: string;       // normalized route path
  content: Record<string, unknown>;
  schemaVersion: number;
  baseCommitSha: string | null;
}

export interface BatchValidationOk {
  ok: true;
  drafts: BatchDraftNormalized[];
}

export interface BatchValidationFail {
  ok: false;
  index: number;
  field: string;
  reason: string;
  detail?: string;
}

export type BatchValidationResult = BatchValidationOk | BatchValidationFail;

/**
 * Shape check. Does NOT call the schema validator — that is composed
 * separately by the route handler so this stays test-friendly without
 * the templates module dep.
 */
export function validateBatchShape(body: unknown): BatchValidationResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, index: -1, field: 'body', reason: 'must_be_object' };
  }
  const drafts = (body as Record<string, unknown>)['drafts'];
  if (!Array.isArray(drafts)) {
    return { ok: false, index: -1, field: 'drafts', reason: 'must_be_array' };
  }
  if (drafts.length === 0) {
    return { ok: false, index: -1, field: 'drafts', reason: 'empty' };
  }
  if (drafts.length > MAX_BATCH_SIZE) {
    return {
      ok: false,
      index: -1,
      field: 'drafts',
      reason: 'too_many',
      detail: `max ${MAX_BATCH_SIZE} per batch`,
    };
  }

  const seenRoutes = new Set<string>();
  const out: BatchDraftNormalized[] = [];

  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    if (!d || typeof d !== 'object') {
      return { ok: false, index: i, field: 'draft', reason: 'must_be_object' };
    }
    const draft = d as Record<string, unknown>;

    const route = normalizeRoute(draft['route']);
    if (!route.ok) {
      return { ok: false, index: i, field: 'route', reason: route.reason, detail: route.detail };
    }
    if (seenRoutes.has(route.path)) {
      return { ok: false, index: i, field: 'route', reason: 'duplicate', detail: route.path };
    }
    seenRoutes.add(route.path);

    const content = draft['content'];
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      return { ok: false, index: i, field: 'content', reason: 'must_be_object' };
    }
    const contentSize = byteLength(JSON.stringify(content));
    if (contentSize > MAX_CONTENT_BYTES_PER_DRAFT) {
      return {
        ok: false,
        index: i,
        field: 'content',
        reason: 'too_large',
        detail: `${contentSize} bytes > max ${MAX_CONTENT_BYTES_PER_DRAFT}`,
      };
    }

    const schemaVersion = draft['schemaVersion'];
    if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
      return { ok: false, index: i, field: 'schemaVersion', reason: 'must_be_positive_integer' };
    }

    let baseCommitSha: string | null = null;
    if (draft['baseCommitSha'] !== undefined && draft['baseCommitSha'] !== null) {
      if (typeof draft['baseCommitSha'] !== 'string' || !/^[0-9a-f]{40}$/i.test(draft['baseCommitSha'])) {
        return { ok: false, index: i, field: 'baseCommitSha', reason: 'must_be_sha1_hex' };
      }
      baseCommitSha = draft['baseCommitSha'];
    }

    out.push({
      route: route.path,
      content: content as Record<string, unknown>,
      schemaVersion,
      baseCommitSha,
    });
  }

  return { ok: true, drafts: out };
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
