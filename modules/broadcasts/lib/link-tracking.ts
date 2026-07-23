/**
 * Broadcast block-level link tracking — pure helpers.
 * Per spec-broadcasts-blocks.md §5.4 (a clone of newsletters/lib/link-tracking.ts).
 *
 * Runtime-agnostic (no DB, no framework, no DOM): used by the block builder /
 * render path (tagging `broadcast_links`) and the `email-webhook` function
 * (parsing `?nlb=`). Keep it dependency-free.
 *
 * This mirrors the newsletters implementation verbatim so both domains share
 * one `?nlb=` scheme (a click can be resolved against either registry). If the
 * two ever converge onto a shared `email_links` table (spec §11 Q2), collapse
 * this into a single shared lib.
 */

// ---------------------------------------------------------------------------
// Types (structural — callers pass their own block/brick shapes)
// ---------------------------------------------------------------------------

export interface LinkSourceBrick {
  id: string;
  brick_type: string;
  content: Record<string, unknown>;
  sort_order: number;
}

export interface LinkSourceBlock {
  id: string;
  block_type: string;
  content: Record<string, unknown>;
  sort_order: number;
  bricks?: LinkSourceBrick[];
  tracking_slug?: string | null;
}

/** One trackable link occurrence within a broadcast, in document order. */
export interface LinkOccurrence {
  block_id: string;
  brick_id: string | null;
  block_type: string;
  tracking_slug: string | null;
  /** Field/anchor path the link came from (e.g. `body`, `jobs[0].apply_link`). */
  field: string;
  /** Stable position within (block_id, field) — supports duplicates. */
  link_index: number;
  original_url: string;
}

/** A registry row as needed for tagging (subset of broadcast_links). */
export interface TaggableLink {
  original_url: string;
  tracking_key: string;
}

// ---------------------------------------------------------------------------
// Trackability
// ---------------------------------------------------------------------------

const UNTRACKABLE_SCHEMES = /^(mailto:|tel:|sms:|#|javascript:)/i;
// Provider/templating tokens that aren't real URLs at extraction time.
const TEMPLATE_TOKEN = /\{\{|\}\}|\{%|%\}/;
// Heuristic for fields whose scalar value is itself a URL.
const LINK_FIELD_NAME = /(^|_)(link|url|href|src)$/i;

/** True if a URL should be tracked (tagged + registered). */
export function isTrackableUrl(url: string): boolean {
  if (!url) return false;
  const u = url.trim();
  if (!u) return false;
  if (UNTRACKABLE_SCHEMES.test(u)) return false;
  if (TEMPLATE_TOKEN.test(u)) return false;
  // unsubscribe / view-in-browser are typically provider tokens or opt-out
  // links we never want to attribute to a block.
  if (/unsubscribe|view[-_]?in[-_]?browser/i.test(u)) return false;
  return /^https?:\/\//i.test(u) || u.startsWith('/');
}

function looksLikeUrl(v: string): boolean {
  return /^https?:\/\//i.test(v.trim());
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const HREF_RE = /href\s*=\s*["']([^"']+)["']/gi;

/** Extract href URLs from an HTML string, in document order. */
export function extractHtmlHrefs(html: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  HREF_RE.lastIndex = 0;
  while ((m = HREF_RE.exec(html)) !== null) {
    out.push(m[1]);
  }
  return out;
}

interface Ctx {
  occ: LinkOccurrence[];
  fieldCount: Map<string, number>;
  block: LinkSourceBlock;
  brickId: string | null;
}

function pushOccurrence(ctx: Ctx, field: string, url: string): void {
  if (!isTrackableUrl(url)) return;
  const idx = ctx.fieldCount.get(field) ?? 0;
  ctx.fieldCount.set(field, idx + 1);
  ctx.occ.push({
    block_id: ctx.block.id,
    brick_id: ctx.brickId,
    block_type: ctx.block.block_type,
    tracking_slug: ctx.block.tracking_slug ?? null,
    field,
    link_index: idx,
    original_url: url,
  });
}

function walkContent(value: unknown, path: string, ctx: Ctx): void {
  if (typeof value === 'string') {
    if (value.includes('<') && /href\s*=/i.test(value)) {
      for (const url of extractHtmlHrefs(value)) pushOccurrence(ctx, path, url);
    } else if (looksLikeUrl(value) && LINK_FIELD_NAME.test(path.replace(/\[\d+\]/g, ''))) {
      pushOccurrence(ctx, path, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkContent(item, `${path}[${i}]`, ctx));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkContent(v, path ? `${path}.${k}` : k, ctx);
    }
  }
}

/**
 * Extract every trackable link occurrence from a broadcast's blocks, in stable
 * document order (block sort_order → brick sort_order → field → position).
 * The returned `(block_id, field, link_index)` tuple is the registry's
 * idempotent upsert key.
 */
export function extractTrackableLinks(blocks: ReadonlyArray<LinkSourceBlock>): LinkOccurrence[] {
  const occ: LinkOccurrence[] = [];
  const sortedBlocks = [...blocks].sort((a, b) => a.sort_order - b.sort_order);
  for (const block of sortedBlocks) {
    // ONE fieldCount per block, shared across the block's own content and ALL
    // its bricks. The registry's UNIQUE key is (block_id, field, link_index)
    // — giving each brick its own fieldCount restarts link_index at 0 and
    // produces colliding tuples, which kills the batch upsert. Sharing the
    // counter keeps each occurrence's tuple distinct; brick identity is still
    // recoverable via the brick_id column.
    const fieldCount = new Map<string, number>();
    const blockCtx: Ctx = { occ, fieldCount, block, brickId: null };
    walkContent(block.content ?? {}, '', blockCtx);
    const bricks = [...(block.bricks ?? [])].sort((a, b) => a.sort_order - b.sort_order);
    for (const brick of bricks) {
      const bctx: Ctx = { occ, fieldCount, block, brickId: brick.id };
      walkContent(brick.content ?? {}, `brick:${brick.brick_type}`, bctx);
    }
  }
  return occ;
}

// ---------------------------------------------------------------------------
// tracking_key
// ---------------------------------------------------------------------------

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Generate a 10-char URL-safe base62 opaque id (~62^10 space). */
export function generateTrackingKey(length = 10): string {
  const bytes = new Uint8Array(length);
  // Available in browser, Deno, and Node 20+ as a global.
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) out += B62[bytes[i] % 62];
  return out;
}

// ---------------------------------------------------------------------------
// URL tagging & parsing
// ---------------------------------------------------------------------------

/**
 * Append/replace `?nlb=<key>` on a URL. Idempotent: an existing nlb param is
 * replaced, not duplicated. Preserves the fragment and other query params.
 */
export function tagUrl(url: string, trackingKey: string): string {
  const hashIdx = url.indexOf('#');
  const fragment = hashIdx >= 0 ? url.slice(hashIdx) : '';
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const qIdx = base.indexOf('?');
  const path = qIdx >= 0 ? base.slice(0, qIdx) : base;
  const query = qIdx >= 0 ? base.slice(qIdx + 1) : '';
  const params = query
    .split('&')
    .filter((p) => p && !/^nlb=/i.test(p));
  params.push(`nlb=${encodeURIComponent(trackingKey)}`);
  return `${path}?${params.join('&')}${fragment}`;
}

/** Extract the `nlb` tracking key from a URL (last value wins). NULL if absent. */
export function parseNlb(url: string): string | null {
  if (!url) return null;
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return null;
  const hashIdx = url.indexOf('#', qIdx);
  const query = url.slice(qIdx + 1, hashIdx >= 0 ? hashIdx : undefined);
  let key: string | null = null;
  for (const part of query.split('&')) {
    const m = /^nlb=(.*)$/i.exec(part);
    if (m) {
      try {
        key = decodeURIComponent(m[1]);
      } catch {
        key = m[1];
      }
    }
  }
  return key && key.length > 0 ? key : null;
}

/**
 * Rewrite the rendered email HTML so each registry link carries its `?nlb=`.
 * Rows MUST be passed in the same order extraction produced them; each row's
 * next un-consumed `href="<original_url>"` occurrence is tagged, so duplicate
 * URLs across blocks get sequential (distinct) keys. Anchors whose href isn't
 * in the registry (static/hardcoded links) are left untouched.
 */
export function tagHtmlLinks(html: string, orderedRows: ReadonlyArray<TaggableLink>): string {
  let result = '';
  let cursor = 0;
  for (const row of orderedRows) {
    const tagged = tagUrl(row.original_url, row.tracking_key);
    // Match either quote style: href="url" or href='url'.
    const needleDq = `href="${row.original_url}"`;
    const needleSq = `href='${row.original_url}'`;
    let idx = html.indexOf(needleDq, cursor);
    let needleLen = needleDq.length;
    let replacement = `href="${tagged}"`;
    const sqIdx = html.indexOf(needleSq, cursor);
    if (sqIdx >= 0 && (idx < 0 || sqIdx < idx)) {
      idx = sqIdx;
      needleLen = needleSq.length;
      replacement = `href='${tagged}'`;
    }
    if (idx < 0) continue; // not found from cursor (static link or out of order)
    result += html.slice(cursor, idx) + replacement;
    cursor = idx + needleLen;
  }
  result += html.slice(cursor);
  return result;
}
