/**
 * Newsletter block-level link tracking — pure helpers (Deno edge-function copy).
 *
 * Mirrors modules/newsletters/lib/link-tracking.ts verbatim. Kept as a
 * standalone file under functions/_shared/ (matching the repo's edge-function
 * sharing convention) so it bundles with the function. If you change one,
 * change both. Pure + dependency-free; uses the global Web Crypto API.
 */

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

export interface LinkOccurrence {
  block_id: string;
  brick_id: string | null;
  block_type: string;
  tracking_slug: string | null;
  field: string;
  link_index: number;
  original_url: string;
}

export interface TaggableLink {
  original_url: string;
  tracking_key: string;
}

const UNTRACKABLE_SCHEMES = /^(mailto:|tel:|sms:|#|javascript:)/i;
const TEMPLATE_TOKEN = /\{\{|\}\}|\{%|%\}/;
const LINK_FIELD_NAME = /(^|_)(link|url|href|src)$/i;

export function isTrackableUrl(url: string): boolean {
  if (!url) return false;
  const u = url.trim();
  if (!u) return false;
  if (UNTRACKABLE_SCHEMES.test(u)) return false;
  if (TEMPLATE_TOKEN.test(u)) return false;
  if (/unsubscribe|view[-_]?in[-_]?browser/i.test(u)) return false;
  return /^https?:\/\//i.test(u) || u.startsWith('/');
}

function looksLikeUrl(v: string): boolean {
  return /^https?:\/\//i.test(v.trim());
}

const HREF_RE = /href\s*=\s*["']([^"']+)["']/gi;

export function extractHtmlHrefs(html: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  HREF_RE.lastIndex = 0;
  while ((m = HREF_RE.exec(html)) !== null) out.push(m[1]);
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

export function extractTrackableLinks(blocks: ReadonlyArray<LinkSourceBlock>): LinkOccurrence[] {
  const occ: LinkOccurrence[] = [];
  const sortedBlocks = [...blocks].sort((a, b) => a.sort_order - b.sort_order);
  for (const block of sortedBlocks) {
    // ONE fieldCount per block, shared across the block's own content and ALL
    // its bricks. The registry's UNIQUE key is (block_id, field, link_index)
    // — when multiple bricks of the same brick_type sit in one block (e.g.
    // three podcast bricks in mlops_community), giving each brick its own
    // fieldCount restarts link_index at 0 and produces colliding tuples. The
    // batch upsert then dies with "ON CONFLICT DO UPDATE command cannot
    // affect row a second time", the catch in syncEditionLinkRegistry
    // swallows it, and the registry never gets populated.
    const fieldCount = new Map<string, number>();
    walkContent(block.content ?? {}, '', { occ, fieldCount, block, brickId: null });
    const bricks = [...(block.bricks ?? [])].sort((a, b) => a.sort_order - b.sort_order);
    for (const brick of bricks) {
      walkContent(brick.content ?? {}, `brick:${brick.brick_type}`, {
        occ, fieldCount, block, brickId: brick.id,
      });
    }
  }
  return occ;
}

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateTrackingKey(length = 10): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) out += B62[bytes[i] % 62];
  return out;
}

export function tagUrl(url: string, trackingKey: string): string {
  const hashIdx = url.indexOf('#');
  const fragment = hashIdx >= 0 ? url.slice(hashIdx) : '';
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const qIdx = base.indexOf('?');
  const path = qIdx >= 0 ? base.slice(0, qIdx) : base;
  const query = qIdx >= 0 ? base.slice(qIdx + 1) : '';
  const params = query.split('&').filter((p) => p && !/^nlb=/i.test(p));
  params.push(`nlb=${encodeURIComponent(trackingKey)}`);
  return `${path}?${params.join('&')}${fragment}`;
}

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
      try { key = decodeURIComponent(m[1]); } catch { key = m[1]; }
    }
  }
  return key && key.length > 0 ? key : null;
}

export function tagHtmlLinks(html: string, orderedRows: ReadonlyArray<TaggableLink>): string {
  let result = '';
  let cursor = 0;
  for (const row of orderedRows) {
    const tagged = tagUrl(row.original_url, row.tracking_key);
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
    if (idx < 0) continue;
    result += html.slice(cursor, idx) + replacement;
    cursor = idx + needleLen;
  }
  result += html.slice(cursor);
  return result;
}
