/**
 * Walk a content tree (any JSON value) and find references to host-media
 * assets. Used by the publish-worker when `site.config.publish.write_media_to_git`
 * is true.
 *
 * Strategy:
 *   - The caller passes a Map<public_url, MediaRef> of every sites_media
 *     row that belongs to this site (preloaded in one query).
 *   - We recursively walk the content tree, looking for string values
 *     that exactly match a known public_url.
 *   - Each match is recorded as an emission job: { mediaId, sourceUrl,
 *     gitRelativePath }. The walker returns a NEW content tree where
 *     every matched URL has been replaced with the relative path.
 *
 * We match by exact URL (not by substring) so a string containing a URL
 * inside HTML or markdown isn't accidentally rewritten — that case needs
 * a richer parser. The schema-driven editor stores media URLs in their
 * own fields (`format: image` / `format: file-url`); rich-text bodies
 * can carry inline `<img src="...">` URLs, but rewriting those requires
 * HTML parsing — flagged as a future enhancement below.
 *
 * Filename collision strategy:
 *   - Source files become `<media-id>-<safe-basename>` in the git tree
 *     so two assets with the same display name don't collide. The
 *     `media-id` prefix is a 12-char slice of the uuid for readability.
 *
 * Pure function — does NOT fetch binaries. The publish-worker fetches
 * separately via the storage adapter, given the emission jobs returned
 * here.
 */

export interface MediaRef {
  id: string;
  /** The URL stored in content fields — usually the public CDN URL. */
  publicUrl: string;
  /** Object-storage path used by the storage adapter to fetch the binary. */
  storagePath: string;
  /** Display filename, for the git tree. */
  filename: string;
  /** Optional MIME — for cache-control headers if we serve from a CDN. */
  mimeType?: string;
}

export interface MediaEmissionJob {
  /** The host-media row id. */
  mediaId: string;
  /** Storage path the publish-worker downloads from. */
  storagePath: string;
  /** Path inside the git tree where the binary should be written. */
  gitRelativePath: string;
  /** MIME, if available. */
  mimeType?: string;
}

export interface WalkContentMediaArgs {
  /** The page's content JSONB (schema-mode) or assembled block content (blocks-mode). */
  content: unknown;
  /** All known sites_media rows for this site, keyed by their public_url. */
  mediaByUrl: ReadonlyMap<string, MediaRef>;
  /**
   * Directory inside the git tree where media goes. Default `public/media`.
   * Theme code references the rewritten paths as `/media/<filename>` (the
   * leading slash matches Next.js's public/ → URL convention).
   */
  outputDir?: string;
}

export interface WalkContentMediaResult {
  /** Content tree with every matched URL rewritten to the relative path. */
  rewrittenContent: unknown;
  /** Per-mediaId: the job to emit a binary to git. Deduplicated. */
  jobs: MediaEmissionJob[];
  /** Count of URL rewrites applied. */
  rewrites: number;
}

const DEFAULT_OUTPUT_DIR = 'public/media';

export function walkContentMedia(args: WalkContentMediaArgs): WalkContentMediaResult {
  const outputDir = args.outputDir ?? DEFAULT_OUTPUT_DIR;
  const jobs = new Map<string, MediaEmissionJob>();
  let rewrites = 0;

  const rewrittenContent = walk(args.content, (value) => {
    if (typeof value !== 'string') return value;
    const ref = args.mediaByUrl.get(value);
    if (!ref) return value;
    rewrites += 1;
    const gitRelativePath = buildGitPath(outputDir, ref);
    if (!jobs.has(ref.id)) {
      const job: MediaEmissionJob = {
        mediaId: ref.id,
        storagePath: ref.storagePath,
        gitRelativePath,
        ...(ref.mimeType ? { mimeType: ref.mimeType } : {}),
      };
      jobs.set(ref.id, job);
    }
    // Rewrite to URL form (leading slash) — Next.js consumes
    // /media/foo.jpg from public/media/foo.jpg.
    return `/${gitRelativePath.replace(/^public\//, '')}`;
  });

  return { rewrittenContent, jobs: Array.from(jobs.values()), rewrites };
}

/** Build the destination path inside the git tree for a media ref. */
function buildGitPath(outputDir: string, ref: MediaRef): string {
  const idPrefix = ref.id.slice(0, 12);
  const safeBase = ref.filename.replace(/[^a-zA-Z0-9._-]/g, '-');
  return `${outputDir}/${idPrefix}-${safeBase}`;
}

/**
 * Recursive walk that applies `transform` to every leaf value (strings,
 * numbers, booleans, null). Objects + arrays are reconstructed.
 */
function walk(value: unknown, transform: (leaf: unknown) => unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, transform));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, transform);
    }
    return out;
  }
  return transform(value);
}
