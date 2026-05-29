/**
 * Raw-source ingestion connector helpers. spec §5.6.
 *
 * Connectors populate the immutable raw/ layer. The interface is small and the
 * I/O (fetching, file upload) is the caller's; these pure builders shape a
 * `RawSourceDraft` (the row the API inserts) and derive a stable path slug from
 * a URL/filename. Built-ins: `url` (via gatewaze-fetch) + `upload`. A
 * `sessionize` connector (CFP submissions) is out of scope but plugs in here.
 */

import { validateSlug, MAX_SEGMENT_LEN } from './slug.js';

export interface RawSourceDraft {
  slug: string;
  source_type: 'url' | 'upload' | 'paste' | 'connector';
  uri: string | null;
  title: string | null;
  content: string;
  metadata: Record<string, unknown>;
}

function clampSeg(s: string): string {
  const seg = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_SEGMENT_LEN);
  return seg || 'item';
}

/** Derive a valid path slug under `prefix` from arbitrary input; falls back safely. */
export function slugifyForRaw(input: string, prefix = 'sources'): string {
  const cleaned = input
    .replace(/^[a-z]+:\/\//i, '') // strip scheme
    .split(/[/?#]+/)
    .map(clampSeg)
    .filter(Boolean)
    .slice(0, 6);
  const candidate = [prefix, ...cleaned].filter(Boolean).join('/');
  return validateSlug(candidate).ok ? candidate : `${prefix}/item-${Date.now().toString(36)}`;
}

export function buildRawSourceFromUrl(args: { url: string; content: string; title?: string | null; prefix?: string }): RawSourceDraft {
  return {
    slug: slugifyForRaw(args.url, args.prefix),
    source_type: 'url',
    uri: args.url,
    title: args.title ?? null,
    content: args.content,
    metadata: { fetched_from: args.url },
  };
}

export function buildRawSourceFromUpload(args: { filename: string; content: string; prefix?: string }): RawSourceDraft {
  return {
    slug: slugifyForRaw(args.filename, args.prefix),
    source_type: 'upload',
    uri: null,
    title: args.filename,
    content: args.content,
    metadata: { filename: args.filename },
  };
}
