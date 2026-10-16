/**
 * Static-HTML publish output.
 *
 * When `sites.config.publish.output === 'static-html'`, the publish
 * branch is a plain static site: one `<full_path>/index.html` per
 * published blocks-mode page, rendered through the same canonical
 * `renderPage` the canvas editor uses (wrapper + blocks), plus
 * sitemap.xml and robots.txt. Any static host — the portal, Netlify,
 * Cloudflare Pages, a local `python -m http.server` — can serve it as is.
 *
 * Nothing here touches the database; register-routes gathers the rows
 * and hands them over.
 */

import {
  renderPageForPublish,
  type PublishRenderRow,
  type PublishRenderBrickRow,
  type PublishRenderBlockDef,
  type PublishRenderBrickDef,
  type PublishRenderWrapper,
} from './canvas-render-bridge.js';

export interface StaticHtmlPage {
  id: string;
  slug: string;
  full_path: string;
  title: string;
  wrapper_id: string | null;
  blocks: ReadonlyArray<PublishRenderRow>;
  bricks: ReadonlyArray<PublishRenderBrickRow>;
}

export interface BuildStaticHtmlArgs {
  siteId: string;
  siteSlug: string;
  brand: string;
  /** Falls back to this wrapper when a page has none. */
  siteWrapperId: string | null;
  pages: ReadonlyArray<StaticHtmlPage>;
  blockDefs: ReadonlyMap<string, PublishRenderBlockDef>;
  brickDefs: ReadonlyMap<string, PublishRenderBrickDef>;
  wrappers: ReadonlyMap<string, PublishRenderWrapper>;
  assets?: ReadonlyMap<string, { url: string; alt?: string }>;
  /** Canonical origin for sitemap.xml, e.g. https://jupyterfoundation.org. Omit to skip the sitemap. */
  canonicalOrigin?: string | null;
}

export interface BuildStaticHtmlResult {
  files: Map<string, string>;
  warnings: Array<{ page: string; code: string; message: string }>;
}

const SEGMENT_RE = /^[a-z0-9][a-z0-9_-]{0,80}$/i;
const RESERVED_TOP_SEGMENTS = new Set(['content', 'public', 'sitemap.xml', 'robots.txt', '.git']);

/**
 * `/about/governing-board` → `about/governing-board/index.html`; `/` →
 * `index.html`. Returns null for a path whose segments could escape the
 * site tree or collide with generated files; the caller skips those.
 */
export function htmlPathFor(fullPath: string): string | null {
  const trimmed = fullPath.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return 'index.html';
  const segments = trimmed.split('/');
  if (!segments.every((s) => SEGMENT_RE.test(s))) return null;
  if (RESERVED_TOP_SEGMENTS.has(segments[0]!.toLowerCase())) return null;
  return `${segments.join('/')}/index.html`;
}

function xmlEsc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c);
}

export function buildStaticHtmlFiles(args: BuildStaticHtmlArgs): BuildStaticHtmlResult {
  const files = new Map<string, string>();
  const warnings: BuildStaticHtmlResult['warnings'] = [];
  const assets = args.assets ?? new Map();

  const emitted = new Set<string>();
  for (const page of args.pages) {
    const htmlPath = htmlPathFor(page.full_path);
    if (!htmlPath || emitted.has(htmlPath)) {
      warnings.push({ page: page.full_path, code: 'static-html.path_rejected', message: `page path not emitted: ${htmlPath ? 'duplicate output path' : 'invalid segment'}` });
      continue;
    }
    emitted.add(htmlPath);
    const wrapperId = page.wrapper_id ?? args.siteWrapperId;
    const result = renderPageForPublish({
      page: {
        id: page.id,
        site_id: args.siteId,
        composition_mode: 'blocks',
        wrapper_id: wrapperId,
        content: null,
        title: page.title,
        full_path: page.full_path,
      },
      blocks: page.blocks,
      bricks: page.bricks,
      blockDefs: args.blockDefs,
      brickDefs: args.brickDefs,
      wrappers: args.wrappers,
      assets,
      siteSlug: args.siteSlug,
      brand: args.brand,
    });
    for (const w of result.warnings) warnings.push({ page: page.full_path, code: w.code, message: w.message });
    files.set(htmlPath, result.html);
  }

  const origin = (args.canonicalOrigin ?? '').replace(/\/+$/, '').replace(/[\r\n]/g, '');
  if (origin) {
    const urls = args.pages
      .filter((p) => htmlPathFor(p.full_path) !== null)
      .map((p) => (p.full_path === '/' ? `${origin}/` : `${origin}${p.full_path.replace(/\/+$/, '')}/`))
      .map((u) => `  <url><loc>${xmlEsc(u)}</loc></url>`)
      .join('\n');
    files.set('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
    files.set('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
  }

  return { files, warnings };
}
