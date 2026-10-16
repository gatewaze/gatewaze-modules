/**
 * Data fill for the LFX blocks that mirror platform data: member logos,
 * upcoming events, latest news.
 *
 * A block instance is data-backed when either its block_def carries a
 * `DATA_SOURCE` of `{ adapter: 'gatewaze', operation: 'lfx.fill' }` or
 * the page_blocks row carries `kind_config.fill`. The instance config
 * wins, so a generic block (the card grid) can be fed from the blog on
 * the News page and stay static elsewhere.
 *
 * The fill runs at import (so the editor shows real rows) and again at
 * every publish (so the published site is current). Editors change the
 * copy around the list; the list itself is owned by the data source.
 */

import type { LfxDataProvider, LfxFieldSource, LfxFill } from './types.js';

export const LFX_FILL_OPERATION = 'lfx.fill';

export interface DataSourceLike {
  adapter?: string;
  operation?: string;
  params?: unknown;
}

export const LFX_FILL_SOURCES = new Set(['membership.members', 'membership.tiers', 'events.upcoming', 'blog.latest']);
export const LFX_FILL_LIMIT_MAX = 100;
const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;
const TIER_RE = /^[a-z0-9_-]{1,40}$/;

/**
 * Strict shape check. `kind_config` is editor-writable, so every value
 * that reaches a query (limit, tiers) is bounded here, not trusted.
 */
function isFill(v: unknown): v is LfxFill {
  if (!v || typeof v !== 'object') return false;
  const fields = (v as { fields?: unknown }).fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 8) return false;
  return entries.every(([name, f]) => {
    if (!FIELD_NAME_RE.test(name) || !f || typeof f !== 'object') return false;
    const src = f as { source?: unknown; limit?: unknown; tiers?: unknown; shape?: unknown };
    if (typeof src.source !== 'string' || !LFX_FILL_SOURCES.has(src.source)) return false;
    if (src.limit !== undefined && !(Number.isInteger(src.limit) && (src.limit as number) >= 1 && (src.limit as number) <= LFX_FILL_LIMIT_MAX)) return false;
    if (src.tiers !== undefined && !(Array.isArray(src.tiers) && src.tiers.length <= 10 && src.tiers.every((t) => typeof t === 'string' && TIER_RE.test(t)))) return false;
    if (src.shape !== undefined && src.shape !== 'posts' && src.shape !== 'cards') return false;
    return true;
  });
}

/** Resolve the effective fill for a block instance: instance config over def data_source. */
export function resolveFill(
  defDataSource: DataSourceLike | null | undefined,
  kindConfig: Record<string, unknown> | null | undefined,
): LfxFill | null {
  const instance = kindConfig?.fill;
  if (isFill(instance)) return instance;
  if (defDataSource && defDataSource.adapter === 'gatewaze' && defDataSource.operation === LFX_FILL_OPERATION && isFill(defDataSource.params)) {
    return defDataSource.params;
  }
  return null;
}

async function fetchField(src: LfxFieldSource, provider: LfxDataProvider): Promise<unknown[]> {
  switch (src.source) {
    case 'membership.members':
      return provider.members({ limit: src.limit, tiers: src.tiers });
    case 'membership.tiers':
      return provider.memberTiers();
    case 'events.upcoming':
      return provider.upcomingEvents(src.limit ?? 10);
    case 'blog.latest': {
      const posts = await provider.latestPosts(src.limit ?? 5);
      if (src.shape === 'cards') {
        return posts.map((p) => ({
          meta: [p.date, p.author].filter(Boolean).join(' · '),
          title: p.title,
          href: p.url,
          text: p.excerpt,
        }));
      }
      return posts;
    }
    default:
      return [];
  }
}

/**
 * Returns a NEW content object with each filled field replaced. Fields
 * not named in the fill are untouched. A provider failure on one field
 * leaves that field as it was (the previous snapshot) and is reported.
 */
export async function fillBlockContent(
  content: Record<string, unknown>,
  fill: LfxFill,
  provider: LfxDataProvider,
): Promise<{ content: Record<string, unknown>; errors: Array<{ field: string; message: string }> }> {
  const out: Record<string, unknown> = { ...content };
  const errors: Array<{ field: string; message: string }> = [];
  for (const [field, src] of Object.entries(fill.fields)) {
    try {
      out[field] = await fetchField(src, provider);
    } catch (err) {
      errors.push({ field, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { content: out, errors };
}
