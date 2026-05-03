/**
 * MediaReferenceTracker — keeps host_media.used_in in sync with the
 * content tables (pages.content, page_blocks.content, page_block_bricks.content,
 * newsletters_edition_blocks.content, newsletters_edition_bricks.content).
 *
 * Per spec-content-modules-git-architecture §18.4:
 *   - Updated transactionally by the API server inside the same DB
 *     transaction that writes referencing content
 *   - Walks JSON depth-limited to 10 levels looking for keys matching
 *     ^(image|image_url|src|href|background_image|.*_image)$
 *   - On content delete, removes the referencing row from used_in arrays
 *   - Nightly reconciliation backstop (sites:media-usage-reconcile cron)
 */

const MAX_DEPTH = 10;
const MEDIA_KEY_RE = /^(image|image_url|src|href|background_image|.*_image)$/i;

export interface MediaReference {
  /** Storage path (relative; resolved via storage_bucket_url at render). */
  storagePath: string;
}

/**
 * Walks an arbitrary JSON value and returns all storage paths referenced.
 * Recognizes both `/media/<path>` style references (in-repo files) and
 * full Supabase Storage URLs.
 */
export function extractMediaReferences(value: unknown, storageBucketUrl?: string): Set<string> {
  const refs = new Set<string>();
  walk(value, 0, refs, storageBucketUrl);
  return refs;
}

function walk(value: unknown, depth: number, refs: Set<string>, storageBucketUrl?: string): void {
  if (depth > MAX_DEPTH) return;
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    // Strings encountered at the top level (no key) are not media refs.
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, depth + 1, refs, storageBucketUrl);
    return;
  }
  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (typeof val === 'string' && MEDIA_KEY_RE.test(key)) {
        const path = normalizeToStoragePath(val, storageBucketUrl);
        if (path) refs.add(path);
      } else {
        walk(val, depth + 1, refs, storageBucketUrl);
      }
    }
  }
}

/**
 * Convert various URL/path shapes into a canonical relative storage path.
 *
 * Handles:
 *   /media/foo.jpg                         → media/foo.jpg
 *   sites/<slug>/media/foo-abc.jpg         → sites/<slug>/media/foo-abc.jpg
 *   https://supabase.../object/.../foo.jpg → object/.../foo.jpg
 *   https://cdn.brandname.com/x/y/foo.jpg  → x/y/foo.jpg (when storage URL matches)
 */
export function normalizeToStoragePath(raw: string, storageBucketUrl?: string): string | null {
  if (!raw) return null;
  // Strip query strings + fragments
  const clean = raw.split('?')[0]!.split('#')[0]!;

  // Already a relative path
  if (!clean.startsWith('http')) {
    return clean.replace(/^\/+/, '');
  }

  // Full URL — strip the bucket origin
  try {
    const url = new URL(clean);
    if (storageBucketUrl) {
      const baseUrl = new URL(storageBucketUrl);
      if (url.host === baseUrl.host) {
        // Drop the storage prefix (e.g., /storage/v1/object/public/)
        return url.pathname.replace(/^\/storage\/v1\/object\/(public|sign)\//, '').replace(/^\/+/, '');
      }
    }
    // Unknown host — can't normalize; treat as opaque external URL (skip)
    return null;
  } catch {
    return null;
  }
}

// ===========================================================================
// Tracker — emits per-row UPDATEs for host_media.used_in within the same
// transaction that writes the content.
// ===========================================================================

export interface ContentReferenceContext {
  /** Type of content — recorded into used_in[].type. */
  contentType: 'page' | 'page_block' | 'edition' | 'edition_block' | 'edition_brick';
  /** ID of the content row (used to find/update used_in entries). */
  contentId: string;
  /** Display name of the content (e.g., page title) shown in admin. */
  contentName: string;
  /** Host (site or list) the content belongs to. */
  hostKind: 'site' | 'list' | 'newsletter';
  hostId: string;
}

export interface MediaTrackerDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };
  storageBucketUrl?: string;
  logger: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export class MediaReferenceTracker {
  constructor(private readonly deps: MediaTrackerDeps) {}

  /**
   * Diff old + new content; add/remove the contentId from the relevant
   * host_media.used_in entries. Designed to be called inside the same
   * transaction that writes the new content (caller passes the txn-bound
   * supabase client via deps).
   */
  async diff(args: {
    oldContent: unknown;
    newContent: unknown;
    ctx: ContentReferenceContext;
  }): Promise<void> {
    const oldRefs = extractMediaReferences(args.oldContent, this.deps.storageBucketUrl);
    const newRefs = extractMediaReferences(args.newContent, this.deps.storageBucketUrl);

    const added = [...newRefs].filter((r) => !oldRefs.has(r));
    const removed = [...oldRefs].filter((r) => !newRefs.has(r));

    for (const path of added) {
      try {
        await this.deps.supabase.rpc('host_media_add_usage', {
          p_storage_path: path,
          p_host_kind: args.ctx.hostKind,
          p_host_id: args.ctx.hostId,
          p_content_type: args.ctx.contentType,
          p_content_id: args.ctx.contentId,
          p_content_name: args.ctx.contentName,
        });
      } catch (err) {
        this.deps.logger.warn('media usage add failed', {
          path, contentId: args.ctx.contentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const path of removed) {
      try {
        await this.deps.supabase.rpc('host_media_remove_usage', {
          p_storage_path: path,
          p_host_kind: args.ctx.hostKind,
          p_host_id: args.ctx.hostId,
          p_content_type: args.ctx.contentType,
          p_content_id: args.ctx.contentId,
        });
      } catch (err) {
        this.deps.logger.warn('media usage remove failed', {
          path, contentId: args.ctx.contentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Called when a content row is fully deleted — removes ALL references
   * to this contentId from used_in arrays across all media in the host.
   */
  async onContentDelete(args: { ctx: ContentReferenceContext }): Promise<void> {
    try {
      await this.deps.supabase.rpc('host_media_remove_all_usage_for', {
        p_host_kind: args.ctx.hostKind,
        p_host_id: args.ctx.hostId,
        p_content_type: args.ctx.contentType,
        p_content_id: args.ctx.contentId,
      });
    } catch (err) {
      this.deps.logger.warn('media usage purge failed', {
        contentId: args.ctx.contentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
