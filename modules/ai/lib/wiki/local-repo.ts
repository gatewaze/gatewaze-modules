/**
 * Local filesystem wiki backend (dual-mode, spec §5.8).
 *
 * When the wiki MCP runs under local Goose with no Supabase, the store of
 * record is the git working tree: markdown files under `<root>/wiki/**` and
 * `<root>/raw/**`. Same tool contract as the DB backend, same on-disk layout
 * and frontmatter (so the SAME repo round-trips between laptop and hosted via
 * git). Search degrades to a keyword scan (no pgvector); the pure lib
 * (slug/links/hash/frontmatter) is shared with the DB path. No DB, no network.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { validateSlug } from './slug.js';
import { parseLinksForPage } from './links.js';
import { contentHash } from './hash.js';
import { serializePage, parseFrontmatter } from './frontmatter.js';

export interface LocalUpsertInput {
  slug: string;
  title: string;
  body: string;
  summary?: string | null;
  category?: string | null;
  metadata?: Record<string, unknown>;
}

function wikiRoot(root: string): string { return join(root, 'wiki'); }
function rawRoot(root: string): string { return join(root, 'raw'); }
function toPosix(p: string): string { return p.split(sep).join('/'); }

function walkMd(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function slugFromPath(base: string, file: string): string {
  return toPosix(relative(base, file)).replace(/\.md$/, '');
}

function whereMatch(metadata: Record<string, unknown>, where?: Record<string, unknown>): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (String((metadata ?? {})[k]) !== String(v)) return false;
  }
  return true;
}

export function upsertPageLocal(root: string, input: LocalUpsertInput): { ok: boolean; slug: string; error?: string } {
  const check = validateSlug(input.slug);
  if (!check.ok) return { ok: false, slug: input.slug, error: `invalid_slug: ${check.reason}` };
  const file = join(wikiRoot(root), `${input.slug}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializePage({
    slug: input.slug, title: input.title, summary: input.summary ?? null, category: input.category ?? null,
    updatedAt: new Date().toISOString(), syncedHash: contentHash(input.title, input.body),
    metadata: input.metadata ?? {}, body: input.body,
  }), 'utf8');
  return { ok: true, slug: input.slug };
}

export interface LocalPage {
  slug: string; title: string; body: string; summary: string | null; category: string | null;
  metadata: Record<string, unknown>; links: string[];
}

export function readPageLocal(root: string, slug: string): LocalPage | null {
  const file = join(wikiRoot(root), `${slug}.md`);
  if (!existsSync(file)) return null;
  const p = parseFrontmatter(readFileSync(file, 'utf8'));
  return {
    slug, title: p.title, body: p.body, summary: p.summary ?? null, category: p.category ?? null,
    metadata: p.metadata, links: parseLinksForPage(p.body, '', slug).map((l) => l.to_slug),
  };
}

export interface LocalListOpts { prefix?: string; category?: string; where?: Record<string, unknown>; limit?: number }

export function listPagesLocal(root: string, opts: LocalListOpts = {}): Array<{ slug: string; title: string; summary: string | null; category: string | null; metadata: Record<string, unknown> }> {
  const base = wikiRoot(root);
  const out = walkMd(base)
    .map((f) => ({ slug: slugFromPath(base, f), fm: parseFrontmatter(readFileSync(f, 'utf8')) }))
    .filter(({ slug, fm }) =>
      (!opts.prefix || slug.startsWith(opts.prefix)) &&
      (!opts.category || fm.category === opts.category) &&
      whereMatch(fm.metadata, opts.where))
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .slice(0, opts.limit ?? 100)
    .map(({ slug, fm }) => ({ slug, title: fm.title, summary: fm.summary ?? null, category: fm.category ?? null, metadata: fm.metadata }));
  return out;
}

export interface LocalSearchResult { slug: string; title: string; summary: string | null; snippet: string; score: number; kind: 'page' }

/** Keyword scan over page files (local has no pgvector → keyword only, spec §5.8). */
export function searchPagesLocal(root: string, opts: { query: string; k?: number }): LocalSearchResult[] {
  const base = wikiRoot(root);
  const terms = opts.query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  if (terms.length === 0) return [];
  const scored = walkMd(base).map((f) => {
    const fm = parseFrontmatter(readFileSync(f, 'utf8'));
    const title = (fm.title || '').toLowerCase();
    const bodyLc = (fm.body || '').toLowerCase();
    let score = 0;
    for (const term of terms) {
      score += occurrences(title, term) * 3 + occurrences(bodyLc, term);
    }
    return { slug: slugFromPath(base, f), fm, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.k ?? 5)
    .map((s) => ({ slug: s.slug, title: s.fm.title, summary: s.fm.summary ?? null, snippet: (s.fm.summary || s.fm.body || '').slice(0, 400), score: s.score, kind: 'page' as const }));
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0; let i = haystack.indexOf(needle);
  while (i !== -1) { n++; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

export function readSourceLocal(root: string, slug: string): { slug: string; title: string | null; content: string; metadata: Record<string, unknown> } | null {
  const file = join(rawRoot(root), `${slug}.md`);
  if (!existsSync(file)) return null;
  const p = parseFrontmatter(readFileSync(file, 'utf8'));
  return { slug, title: p.title || null, content: p.body, metadata: p.metadata };
}

export function listSourcesLocal(root: string, opts: { prefix?: string; limit?: number } = {}): Array<{ slug: string; title: string | null }> {
  const base = rawRoot(root);
  return walkMd(base)
    .map((f) => ({ slug: slugFromPath(base, f), fm: parseFrontmatter(readFileSync(f, 'utf8')) }))
    .filter(({ slug }) => !opts.prefix || slug.startsWith(opts.prefix))
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .slice(0, opts.limit ?? 100)
    .map(({ slug, fm }) => ({ slug, title: fm.title || null }));
}
