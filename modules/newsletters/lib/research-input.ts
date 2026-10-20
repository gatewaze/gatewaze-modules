/**
 * The `discovery_posts` research input and the `template` transform
 * (spec-content-discovery-and-research-blocks.md §5.1, §5.2).
 *
 * Input: external blog_posts landed by the content-sources FeedScraper,
 * inside the research window, in the requested publish states, with a date
 * unless `require_date` is false, minus the keys the previous edition used.
 *
 * Transform (template): one keyed item per post with the compact-digest
 * fields the lf_blogs block renders (headline, url, source, date, blurb).
 * Grouping and caps are NOT applied here: they belong to the resolver at
 * read time, after the author's edits (lib/research-merge.ts), so a removal
 * frees a slot and an addition takes one.
 *
 * The blurb rules are the harvest's (render.py entry_blurb), kept here as a
 * small copy of content-sources/lib/blurb.js so this branch does not depend
 * on that module being present; the two carry the same test cases.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ResearchWindow } from './research-window.js';

export interface DiscoveryPostsInput {
  kind: 'discovery_posts';
  foundations?: 'all' | string[];
  publish_states?: string[];
  require_date?: boolean;
}

export interface ResearchPostItem {
  key: string;            // normalised canonical URL (stable across runs)
  group: string;          // foundation label (group_by=foundation) or project
  headline: string;
  url: string;
  source: string;         // project label
  foundation: string;
  published_at: string | null;
  date_label: string;     // "Sep 17"
  summary: string;        // the blurb, '' when suppressed
  tag?: string;
}

const BLURB_LIMIT = 150;
const RELEASE = /(\bv?\d+\.\d+(\.\d+)?\b.*\b(release|released|announcing|current|lts)\b|\b(release|released|announcing)\b.*\bv?\d+\.\d+(\.\d+)?\b|\bends on\b)/i;
const BOILER = [
  /^(Agentic AI Foundation( New York City)?( · Agentic AI Foundation & Linux Foundation)?\s+)+/,
  /^(Highlights|Why we did this at all|Overview|Introduction|Why [A-Z][\w ]+\?|TL;DR|Scope)\s+/,
  /^Download this case study in PDF version\s+(Overview\s+)?/,
  /^[A-Z][\w.-]+ [A-Z][\w.-]+ Co-founder[^.]*?\bBy /,
];
const JUNK = /(appeared first on|All BlogsBlogs|Table of contents|^\w+ \w+ \w+ is the |^[A-Z]\w+ [A-Z]\w+ [A-Z]\w+ is |^[A-Z]\w+ [A-Z]\w+ (VP|Head|Executive Director) of )/i;

function cleanText(s: string): string {
  let t = String(s ?? '').slice(0, 20_000).replace(/<[^<>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  for (const re of BOILER) t = t.replace(re, '');
  return t;
}

export function oneSentence(s: string, limit = BLURB_LIMIT): string {
  const t = cleanText(s);
  if (!t) return '';
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  let sent = m && m[1].length >= 40 ? m[1] : t;
  if (sent.length > limit) {
    sent = sent.slice(0, limit);
    const cut = sent.lastIndexOf(' ');
    if (cut > 0) sent = sent.slice(0, cut);
    sent = sent.replace(/[,;:]+$/, '') + '…';
  }
  return sent;
}

const core = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');

export function entryBlurb(title: string, excerpt: string | null | undefined, suppressReleaseTitles = true): string {
  if (suppressReleaseTitles && RELEASE.test(title)) return '';
  const b = oneSentence(excerpt ?? '');
  if (!b || JUNK.test(b)) return '';
  const titleCore = core(title.split(' - Agentic')[0]).slice(0, 40);
  if (titleCore && core(b).startsWith(titleCore) && b.length < title.length + 30) return '';
  return b;
}

export function dateLabel(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** JS twin of discovery_normalize_url, enough for a stable item key (the stored canonical_url_norm is preferred when present). */
export function normalizeKey(url: string): string {
  let u = String(url ?? '').trim().replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/#.*$/, '');
  const host = (u.match(/^([^/?]+)/)?.[1] ?? '').toLowerCase().replace(/^www\./, '');
  const rest = u.slice(host.length ? u.indexOf(host.replace(/^www\./, '')) + host.length : 0);
  const q = rest.indexOf('?');
  let path = q >= 0 ? rest.slice(0, q) : rest;
  const params = (q >= 0 ? rest.slice(q + 1) : '').split('&').filter((p) => p && !/^(utm_[^=]*|fbclid|gclid|ref|source)(=|$)/i.test(p)).sort();
  path = path === '' || path === '/' ? '' : path.replace(/\/+$/, '');
  return host + path + (params.length ? '?' + params.join('&') : '');
}

export interface DiscoveryQueryResult {
  items: ResearchPostItem[];
  summary: { fetched: number; excluded_previous: number; undated_dropped: number; window: ResearchWindow; foundations: number };
}

/**
 * Query + transform. `groupBy` decides what `group` carries ('foundation'
 * default). Items come back newest first; the resolver groups and caps.
 */
export async function queryDiscoveryPosts(
  sb: SupabaseClient,
  input: DiscoveryPostsInput,
  window: ResearchWindow,
  opts: { groupBy?: 'foundation' | 'project'; blurb?: 'first_sentence' | 'none'; suppressReleaseTitles?: boolean; limit?: number } = {},
): Promise<DiscoveryQueryResult> {
  const states = (input.publish_states && input.publish_states.length ? input.publish_states : ['published', 'pending_review']).filter((s) => /^[a-z_]{1,32}$/.test(s));
  const requireDate = input.require_date !== false;
  let q = sb
    .from('blog_posts')
    .select('id, title, excerpt, canonical_url, canonical_url_norm, published_at, publish_state, discovery_sources!inner(foundation, project, status)')
    .eq('is_external', true)
    .not('discovery_source_id', 'is', null)
    .in('publish_state', states)
    .lte('published_at', window.to)
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(Math.min(opts.limit ?? 1000, 2000));
  q = requireDate ? q.gte('published_at', window.from) : q.or(`published_at.gte.${window.from},published_at.is.null`);
  if (Array.isArray(input.foundations) && input.foundations.length) {
    const safe = input.foundations.filter((f) => typeof f === 'string' && f.length <= 200);
    q = q.in('discovery_sources.foundation', safe);
  }
  const { data, error } = await q;
  if (error) throw new Error(`discovery_posts query failed: ${error.message}`);
  const exclude = new Set(window.excludeKeys);
  const items: ResearchPostItem[] = [];
  let excludedPrev = 0;
  let undated = 0;
  const foundations = new Set<string>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const src = row.discovery_sources as { foundation: string; project: string; status: string } | null;
    const url = typeof row.canonical_url === 'string' ? row.canonical_url : null;
    if (!url || !src) continue;
    if (!row.published_at && requireDate) { undated++; continue; }
    const key = (typeof row.canonical_url_norm === 'string' && row.canonical_url_norm) || normalizeKey(url);
    if (exclude.has(key)) { excludedPrev++; continue; }
    const title = String(row.title ?? '').trim();
    if (!title) continue;
    foundations.add(src.foundation);
    items.push({
      key,
      group: opts.groupBy === 'project' ? src.project : src.foundation,
      headline: title.replace(/ - Agentic AI Foundation \(AAIF\)$/, '').slice(0, 300),
      url,
      source: src.project,
      foundation: src.foundation,
      published_at: (row.published_at as string | null) ?? null,
      date_label: dateLabel((row.published_at as string | null) ?? null),
      summary: opts.blurb === 'none' ? '' : entryBlurb(title, row.excerpt as string | null, opts.suppressReleaseTitles !== false),
    });
  }
  return { items, summary: { fetched: (data ?? []).length, excluded_previous: excludedPrev, undated_dropped: undated, window, foundations: foundations.size } };
}
