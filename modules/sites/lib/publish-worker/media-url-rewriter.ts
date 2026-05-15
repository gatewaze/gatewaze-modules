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

import { extractMediaReferences, normalizeToStoragePath } from '../media/reference-tracker.js';

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
  /**
   * Per `sites.config.publish.embed_media_in_git`. When true, items with
   * `host_media.in_repo = true` get rewritten to a RELATIVE path
   * (`/media/<safe-name>`) and an emission job is returned so the
   * publish-worker can download + write the binary into the git tree.
   * When false (default) we keep the current behaviour: everything
   * rewrites to its CDN URL.
   */
  embedMediaInGit?: boolean;
}

export interface MediaEmitJob {
  /** Storage path the publish-worker downloads from (via the media adapter). */
  storagePath: string;
  /** Path inside the git tree where the binary should be written. */
  gitRelativePath: string;
  /** Original mime_type / bytes — informational. */
  mimeType: string;
  bytes: number;
}

export interface RewriteResult {
  /** Content with `/media/...` references rewritten to either CDN URLs or
   *  in-repo relative paths (mix depending on each item's in_repo + the
   *  site-level embedMediaInGit flag). */
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
  /** Per-storage-path emission jobs — the publish-worker downloads each
   *  binary and writes it to gitRelativePath. Empty when embedMediaInGit
   *  is false. */
  emitJobs: MediaEmitJob[];
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
  // Storage bucket URL lets the walker normalize absolute Supabase URLs
  // (the shape platform-emitted asset.url / asset._ref hold) back to a
  // storage_path so host_media lookups + the embed-media-in-git path
  // catch them. Without this only `/media/<path>` placeholder strings
  // are detected.
  const sampleStorageUrl = deps.resolveMediaUrl('');
  const storageBucketUrl = sampleStorageUrl
    .replace(/\/storage\/v1\/object\/(public|sign)\/[^/]+\/?$/, '')
    .replace(/\/+$/, '') || undefined;
  const refs = extractMediaReferences(content, storageBucketUrl);
  if (refs.size === 0) {
    return { rewrittenContent: content, manifestEntries: [], referencedPaths: new Set(), emitJobs: [] };
  }

  // Lookup all referenced media in one query
  const result = await deps.supabase
    .from('host_media')
    .select('storage_path, in_repo, mime_type, bytes')
    .eq('host_kind', hostKind).eq('host_id', hostId)
    .in('storage_path', [...refs]);
  const items = ((result as { data: Array<{ storage_path: string; in_repo: boolean; mime_type: string; bytes: number }> | null }).data ?? []);
  const itemByPath = new Map(items.map((i) => [i.storage_path, i]));

  // Build URL map: relative path → final URL (or relative in-tree path)
  const urlMap = new Map<string, string>();
  const manifestEntries: RewriteResult['manifestEntries'] = [];
  const emitJobs: MediaEmitJob[] = [];

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

    // When the site opts into media-in-git AND this item is small enough
    // to be embedded (in_repo=true), use a relative path so the published
    // site has no runtime dependency on the storage adapter.
    if (deps.embedMediaInGit && item.in_repo) {
      const gitRelativePath = `public/media/${safeFilename(item.storage_path)}`;
      const urlForm = `/media/${safeFilename(item.storage_path)}`;
      urlMap.set(ref, urlForm);
      emitJobs.push({
        storagePath: item.storage_path,
        gitRelativePath,
        mimeType: item.mime_type,
        bytes: item.bytes,
      });
    } else {
      urlMap.set(ref, finalUrl);
    }

    if (!item.in_repo) {
      // Large asset — emit a manifest entry (regardless of the site flag,
      // since by definition CDN-only items can't be inlined)
      manifestEntries.push({
        path: item.storage_path,
        sha256: null, // computed at upload time; not surfaced here for v1
        cdn_url: finalUrl,
        bytes: item.bytes,
        mime_type: item.mime_type,
      });
    }
  }

  const rewritten = walkRewrite(content, 0, urlMap, storageBucketUrl);
  return { rewrittenContent: rewritten, manifestEntries, referencedPaths: refs, emitJobs };
}

/** Map a storage path to a filesystem-safe basename for the git tree. */
function safeFilename(storagePath: string): string {
  // Strip leading dirs (`sites/<id>/media/<file>` → `<file>`), keep the
  // extension, replace anything funky with `-`.
  const basename = storagePath.split('/').filter(Boolean).pop() ?? 'asset';
  return basename.replace(/[^a-zA-Z0-9._-]/g, '-');
}

const MAX_DEPTH = 10;
// Mirrors reference-tracker.ts — also walks `url` / `_ref` keys so the
// rewriter rewrites URLs nested under Sanity-shape image objects
// (`asset.url`, `asset._ref`). Strings that don't normalize to a known
// storage path are left untouched.
const MEDIA_KEY_RE = /^(image|image_url|src|href|background_image|url|_ref|.*_image)$/i;

function walkRewrite(
  value: unknown,
  depth: number,
  urlMap: Map<string, string>,
  storageBucketUrl?: string,
): unknown {
  if (depth > MAX_DEPTH) return value;
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => walkRewrite(item, depth + 1, urlMap, storageBucketUrl));
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string' && MEDIA_KEY_RE.test(key)) {
      // Normalize via the same logic extractMediaReferences uses so
      // absolute Supabase URLs (asset.url/asset._ref shapes from the
      // Sanity importer) get matched to a storage_path the urlMap
      // is keyed by.
      const normalized = normalizeToStoragePath(val, storageBucketUrl);
      const rewritten = normalized ? urlMap.get(normalized) : undefined;
      out[key] = rewritten ?? val;
    } else {
      out[key] = walkRewrite(val, depth + 1, urlMap, storageBucketUrl);
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
      $schema: 'https://schemas.example.com/media-manifest/v1.json',
      version: '1.0.0',
      generated_at: new Date().toISOString(),
      entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    },
    null,
    2,
  );
}
