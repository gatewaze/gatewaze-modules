/**
 * Public read-only blog API.
 *
 * Mounted on the platform's public router (no JWT required). Themes /
 * static-site generators / a Next.js app consume these endpoints
 * to render published blog content from Gatewaze's blog_posts table
 * (replacing direct Sanity queries where applicable).
 *
 *   GET /api/blog/posts                — list published posts
 *     ?limit=N (default 20, max 100)
 *     ?offset=N
 *     ?category=<slug>                 — filter by single category slug
 *     ?tag=<slug>                      — filter by single tag slug
 *     ?search=<text>                   — ilike on title + excerpt
 *     ?featured=true                   — only is_featured posts
 *   GET /api/blog/posts/:slug          — single post by slug
 *   GET /api/blog/tags                 — list all tags
 *   GET /api/blog/categories           — list all categories
 *
 * Response shape mirrors blog_posts + nested category + tags arrays so
 * a single round-trip gives the theme everything it needs.
 *
 * All endpoints:
 *   - filter to status='published' AND visibility='public'
 *   - cache hint: Cache-Control: public, max-age=60, s-maxage=300
 *   - no auth required
 */

import { createHash } from 'node:crypto';

import type { Request, Response, Router } from 'express';

interface ErrorEnvelope {
  error: string;
  message: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const CACHE_HEADER = 'public, max-age=60, s-maxage=300, stale-if-error=86400';

export interface PublicBlogRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

function paramAs(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return undefined;
}

function clampLimit(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function clampOffset(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : 0;
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

export function createPublicBlogRoutes(deps: PublicBlogRoutesDeps) {
  const { supabase, logger } = deps;

  async function listPosts(req: Request, res: Response): Promise<void> {
    const limit = clampLimit(paramAs(req.query.limit));
    const offset = clampOffset(paramAs(req.query.offset));
    const categorySlug = paramAs(req.query.category);
    const tagSlug = paramAs(req.query.tag);
    const search = paramAs(req.query.search);
    const featured = paramAs(req.query.featured) === 'true';

    // Build the base query with nested category + tags. Postgrest does
    // the join in one round-trip.
    let query = supabase
      .from('blog_posts')
      .select(
        'id, title, slug, excerpt, featured_image, featured_image_alt, published_at, is_featured, reading_time, word_count, meta_title, meta_description, ' +
        'category:blog_categories(id, name, slug, color), ' +
        'tags:blog_post_tags(tag:blog_tags(id, name, slug, color)), ' +
        'author_id'  // FK to people.id; the theme fetches author detail via /api/people/:id when needed (no PostgREST FK yet)
      )
      .eq('status', 'published')
      .eq('visibility', 'public')
      .order('published_at', { ascending: false });

    if (categorySlug) query = query.eq('category.slug', categorySlug);
    if (featured) query = query.eq('is_featured', true);
    if (search) {
      // ilike on title + excerpt. The `.or()` PostgREST string is a
      // known injection vector; sanitise both inputs by stripping the
      // filter metacharacters before interpolation.
      const safe = search.replace(/[,()*\\]/g, '').slice(0, 100);
      if (safe.length > 0) {
        query = query.or(`title.ilike.%${safe}%,excerpt.ilike.%${safe}%`);
      }
    }
    query = query.range(offset, offset + limit - 1);

    const result = await query;
    if (result.error) {
      logger.warn('blog.public.list.db_error', { error: result.error.message });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }

    // Flatten nested tags array + optional tag-slug post-filter.
    let posts = ((result.data ?? []) as Array<Record<string, unknown>>).map((p) => ({
      ...p,
      tags: ((p.tags as Array<{ tag?: unknown }> | undefined) ?? [])
        .map((entry) => entry.tag)
        .filter((t) => t !== undefined && t !== null),
    }));

    if (tagSlug) {
      posts = posts.filter((p) =>
        ((p.tags as Array<{ slug?: string }> | undefined) ?? []).some((t) => t.slug === tagSlug),
      );
    }

    // List variants get an extra surrogate key when filtered, so a tag
    // mutation can purge just the affected list rather than all blog
    // list responses.
    const keys: string[] = ['blog'];
    if (tagSlug) keys.push(`blog:tag:${tagSlug}`);
    if (categorySlug) keys.push(`blog:category:${categorySlug}`);
    sendCacheable(req, res, { posts, limit, offset }, keys);
  }

  async function getPost(req: Request, res: Response): Promise<void> {
    const slug = paramAs(req.params.slug);
    if (!slug) {
      sendError(res, 400, 'missing_slug', 'slug required');
      return;
    }
    const result = await supabase
      .from('blog_posts')
      .select(
        'id, title, slug, excerpt, content, featured_image, featured_image_alt, published_at, is_featured, reading_time, word_count, ' +
        'meta_title, meta_description, canonical_url, og_title, og_description, og_image, twitter_title, twitter_description, twitter_image, ' +
        'category:blog_categories(id, name, slug, color), ' +
        'tags:blog_post_tags(tag:blog_tags(id, name, slug, color)), ' +
        'author_id'  // FK to people.id; the theme fetches author detail via /api/people/:id when needed (no PostgREST FK yet)
      )
      .eq('slug', slug)
      .eq('status', 'published')
      .eq('visibility', 'public')
      .maybeSingle();

    if (result.error) {
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    if (!result.data) {
      sendError(res, 404, 'not_found', `blog post '${slug}' not found`);
      return;
    }

    const post = result.data as Record<string, unknown>;
    const flat = {
      ...post,
      tags: ((post.tags as Array<{ tag?: unknown }> | undefined) ?? [])
        .map((entry) => entry.tag)
        .filter((t) => t !== undefined && t !== null),
    };
    sendCacheable(req, res, flat, ['blog', `blog:post:${slug}`]);
  }

  async function listTags(req: Request, res: Response): Promise<void> {
    const result = await supabase
      .from('blog_tags')
      .select('id, name, slug, color, description, post_count')
      .order('name', { ascending: true });
    if (result.error) {
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    sendCacheable(req, res, { tags: result.data ?? [] }, ['blog', 'blog:tags']);
  }

  async function listCategories(req: Request, res: Response): Promise<void> {
    const result = await supabase
      .from('blog_categories')
      .select('id, name, slug, color, description, post_count')
      .order('name', { ascending: true });
    if (result.error) {
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    sendCacheable(
      req,
      res,
      { categories: result.data ?? [] },
      ['blog', 'blog:categories'],
    );
  }

  return { listPosts, getPost, listTags, listCategories };
}

export function mountPublicBlogRoutes(
  router: Router,
  routes: ReturnType<typeof createPublicBlogRoutes>,
): void {
  router.get('/blog/posts', routes.listPosts);
  router.get('/blog/posts/:slug', routes.getPost);
  router.get('/blog/tags', routes.listTags);
  router.get('/blog/categories', routes.listCategories);
}

function sendError(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ error, message } satisfies ErrorEnvelope);
}

/**
 * Emit a cacheable response with the headers the Layer-3 CDN expects:
 *
 *   Cache-Control:  public, max-age=60, s-maxage=300, stale-if-error=86400
 *   Surrogate-Key:  <topic> [<topic>:<id-or-slug> ...]
 *   ETag:           W/"<sha256(body)[0:16]>"
 *
 * Spec: §5.4 of spec-api-cache-and-revalidation.md.
 *
 * If the client's `If-None-Match` matches the computed ETag we return
 * 304 with no body (origin bandwidth save inside the max-age window).
 */
function sendCacheable(
  req: Request,
  res: Response,
  body: unknown,
  surrogateKeys: string[],
): void {
  const json = JSON.stringify(body);
  const etag = `W/"${createHash('sha256').update(json).digest('hex').slice(0, 16)}"`;
  res.setHeader('Cache-Control', CACHE_HEADER);
  res.setHeader('Surrogate-Key', surrogateKeys.join(' '));
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.status(200).type('application/json').send(json);
}
