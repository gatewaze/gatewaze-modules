/**
 * Publish-time media URL rewriter.
 *
 * Per spec-content-modules-git-architecture §14.2 + §14.3:
 *
 *   1. Walks the published content + rendered HTML for `/media/<path>`
 *      references
 *   2. Resolves each to its host_media row
 *   3. Rewrites to:
 *      - Bunny CDN URL if bunny-cdn module installed (via getBunnyImageUrl)
 *      - Supabase Storage public URL otherwise
 *   4. Generates a media-manifest.json entry for any large file (>2MB)
 *      kept CDN-only
 *
 * Used by buildSiteContentFiles when assembling the publish branch.
 */

import { extractMediaReferences } from '../media/reference-tracker.js';

export interface MediaUrlRewriterDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  /** Bunny CDN module's URL rewriter when installed; null otherwise. */
  bunnyRewriter: ((supabaseUrl: string) => string) | null;
  /** Resolve a relative media path → public CDN URL. */
  resolveMediaUrl: (storagePath: string) => string;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface RewriteResult {
  /** Content with `/media/...` references rewritten to CDN URLs. */
  rewrittenContent: unknown;
  /** Manifest entries for media items kept CDN-only (>2MB threshold). */
  manifestEntries: Array<{
    path: string;
    sha256: string | null;
    cdn_url: string;
    bytes: number;
    mime_type: string;
  }>;
  /** Set of media paths actually referenced (for unused-media reporting). */
  referencedPaths: Set<string>;
}

/**
 * Rewrite media URLs in a JSONB content tree.
 *
 * The walker mirrors extractMediaReferences but rewrites in place
 * (returns a new tree) instead of just collecting paths.
 */
export async function rewriteMediaUrlsInContent(
  hostKind: 'site' | 'list',
  hostId: string,
  content: unknown,
  deps: MediaUrlRewriterDeps,
): Promise<RewriteResult> {
  const refs = extractMediaReferences(content);
  if (refs.size === 0) {
    return { rewrittenContent: content, manifestEntries: [], referencedPaths: new Set() };
  }

  // Lookup all referenced media in one query
  const result = await deps.supabase
    .from('host_media')
    .select('storage_path, in_repo, mime_type, bytes')
    .eq('host_kind', hostKind).eq('host_id', hostId)
    .in('storage_path', [...refs]);
  const items = ((result as { data: Array<{ storage_path: string; in_repo: boolean; mime_type: string; bytes: number }> | null }).data ?? []);
  const itemByPath = new Map(items.map((i) => [i.storage_path, i]));

  // Build URL map: relative path → final URL
  const urlMap = new Map<string, string>();
  const manifestEntries: RewriteResult['manifestEntries'] = [];
  for (const ref of refs) {
    const item = itemByPath.get(ref);
    if (!item) {
      // Reference to a media path that doesn't exist in host_media — leave
      // as-is (the renderer will surface a broken image; admin sees a
      // warning at publish time)
      deps.logger.warn('media reference not found in host_media', { path: ref });
      continue;
    }
    const supabaseUrl = deps.resolveMediaUrl(item.storage_path);
    const finalUrl = deps.bunnyRewriter ? deps.bunnyRewriter(supabaseUrl) : supabaseUrl;
    urlMap.set(ref, finalUrl);

    if (!item.in_repo) {
      // Large asset — emit a manifest entry
      manifestEntries.push({
        path: item.storage_path,
        sha256: null, // computed at upload time; not surfaced here for v1
        cdn_url: finalUrl,
        bytes: item.bytes,
        mime_type: item.mime_type,
      });
    }
  }

  const rewritten = walkRewrite(content, 0, urlMap);
  return { rewrittenContent: rewritten, manifestEntries, referencedPaths: refs };
}

const MAX_DEPTH = 10;
const MEDIA_KEY_RE = /^(image|image_url|src|href|background_image|.*_image)$/i;

function walkRewrite(value: unknown, depth: number, urlMap: Map<string, string>): unknown {
  if (depth > MAX_DEPTH) return value;
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => walkRewrite(item, depth + 1, urlMap));
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string' && MEDIA_KEY_RE.test(key)) {
      const cleaned = val.split('?')[0]!.split('#')[0]!.replace(/^\/+/, '');
      const rewritten = urlMap.get(cleaned);
      out[key] = rewritten ?? val;
    } else {
      out[key] = walkRewrite(val, depth + 1, urlMap);
    }
  }
  return out;
}

/**
 * Build the media-manifest.json file content for the publish branch.
 * Per spec §9.3: lists CDN-only media items so designers can run
 * `gatewaze pull-media` to materialize originals locally.
 */
export function buildMediaManifest(entries: RewriteResult['manifestEntries']): string {
  return JSON.stringify(
    {
      $schema: 'https://schemas.gatewaze.com/media-manifest/v1.json',
      version: '1.0.0',
      generated_at: new Date().toISOString(),
      entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    },
    null,
    2,
  );
}
