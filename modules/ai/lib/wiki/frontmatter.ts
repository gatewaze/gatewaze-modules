/**
 * Markdown frontmatter (de)serialization for the git mirror. spec §4.4, §7.
 *
 * A page file is YAML frontmatter + markdown body. Reserved keys (slug, title,
 * summary, category, updated_at, gw_synced_hash) are split out on parse;
 * everything else is the page's queryable `metadata`. The hidden
 * `gw_synced_hash` carries the content_hash the file represents, so the pull
 * worker can detect the loop-break and conflicts (§7.2) without a base copy.
 */

import yaml from 'js-yaml';

const RESERVED = ['slug', 'title', 'summary', 'category', 'updated_at', 'gw_synced_hash'] as const;

export interface PageFile {
  slug?: string;
  title: string;
  summary?: string | null;
  category?: string | null;
  updatedAt?: string | null;
  syncedHash?: string | null; // content_hash this file represents (gw_synced_hash)
  metadata: Record<string, unknown>;
  body: string;
}

export function serializePage(p: PageFile): string {
  const fm: Record<string, unknown> = { ...(p.metadata ?? {}) };
  // Reserved keys win over any metadata collision.
  if (p.slug != null) fm.slug = p.slug;
  fm.title = p.title;
  if (p.summary != null) fm.summary = p.summary;
  if (p.category != null) fm.category = p.category;
  if (p.updatedAt != null) fm.updated_at = p.updatedAt;
  if (p.syncedHash != null) fm.gw_synced_hash = p.syncedHash;
  const front = yaml.dump(fm, { lineWidth: -1, sortKeys: false }).trimEnd();
  return `---\n${front}\n---\n\n${p.body.replace(/^\n+/, '')}`;
}

export function parseFrontmatter(text: string): PageFile {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { title: '', metadata: {}, body: text };
  let obj: Record<string, unknown> = {};
  try {
    const loaded = yaml.load(m[1]!);
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) obj = loaded as Record<string, unknown>;
  } catch {
    return { title: '', metadata: {}, body: text }; // malformed frontmatter → treat all as body
  }
  const body = text.slice(m[0].length).replace(/^\n+/, '');
  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!(RESERVED as readonly string[]).includes(k)) metadata[k] = v;
  }
  return {
    ...(typeof obj.slug === 'string' ? { slug: obj.slug } : {}),
    title: typeof obj.title === 'string' ? obj.title : '',
    summary: (obj.summary as string | null | undefined) ?? null,
    category: (obj.category as string | null | undefined) ?? null,
    updatedAt: (obj.updated_at as string | null | undefined) ?? null,
    syncedHash: (obj.gw_synced_hash as string | null | undefined) ?? null,
    metadata,
    body,
  };
}
