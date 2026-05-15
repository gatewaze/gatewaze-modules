/**
 * emitNextjsRoutes — generate `app/<slug>/page.tsx` files for blocks-mode
 * pages, written to the publish branch alongside content/pages/<slug>.json.
 *
 * Per spec-content-modules-git-architecture §8.4 + §10.3:
 *   - For each blocks-mode page: emit a Server Component that imports
 *     the components per `component_export_path` and renders them
 *     with the saved props from content/pages/<slug>.json.
 *   - For pages with a wrapper_id assigned, emit `app/(<wrapper-name>)/<slug>/page.tsx`
 *     (Next.js route group syntax) so the page wrapper's
 *     `theme/app/(<wrapper-name>)/layout.tsx` applies.
 *   - Schema-mode pages: NOT emitted — the theme owns those route files
 *     in `main`; gatewaze just merges them through to publish.
 *   - Site wrapper: emit `theme/app/layout.tsx` for blocks-mode sites
 *     that import the site-level wrapper component.
 *
 * Returns the same Map<path, contents> that buildSiteContentFiles
 * returns, additive to the content/*.json files.
 */

interface BlocksPagePayload {
  slug: string;
  full_path: string;
  composition_mode: 'blocks';
  blocks: Array<{
    block_def_name: string;
    component_export_path: string | null;
    sort_order: number;
    content: Record<string, unknown>;
  }>;
}

interface WrapperRow {
  id: string;
  name: string;
  role: 'site' | 'page';
  component_export_path: string | null;
}

export interface EmitRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  /** Site row — needed for wrapper_id resolution + analytics injection. */
  site: {
    id: string;
    wrapper_id: string | null;
    /** Read from sites.config — used to inject analytics tags into the layout head. */
    analytics?: {
      provider?: 'plausible' | 'fathom' | 'umami' | 'ga4' | 'none';
      umami?: { umamiWebsiteId?: string; umamiShareId?: string | null };
    } | null;
  };
  /**
   * Per-integration runtime config — operator-supplied URLs/tokens.
   * Today only `umamiUrl` is consumed (script.js src). The integrations-
   * umami module's installed_modules.config supplies it; the publish-worker
   * resolves it before calling emitNextjsRoutes.
   */
  integrations?: {
    umamiUrl?: string;
  };
  /**
   * Origin where the platform's public API is reachable from the rendered
   * site (e.g. https://api.example.com). The A/B client script POSTs to
   * `${apiOrigin}/api/ab/:testId/{assign,impression,conversion}`.
   * When absent, the A/B client script is omitted entirely.
   */
  apiOrigin?: string | null;
  /**
   * Per-page A/B test bindings. Resolved by the publish-worker from
   * `templates_ab_tests` (status=running, scope_kind='page'). Each emitted
   * page checks this map by `page.full_path` and, if a test is bound,
   * inlines a small client snippet that:
   *   1. Mints / reads a localStorage session key
   *   2. POSTs `assign` to get the sticky variant
   *   3. Sets `<body data-ab-variant="…">` so per-variant CSS / JS keys off it
   *   4. POSTs `impression` once on first paint
   *   5. Exposes `window.gatewazeAB.recordConversion(goalEvent)` for client code
   */
  abTestsByRoute?: Record<string, AbTestBinding>;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface AbTestBinding {
  testId: string;
  goalEvent: string;
}

export interface PageWithWrapper {
  slug: string;
  full_path: string;
  wrapper_id: string | null;
  composition_mode: 'schema' | 'blocks';
}

/**
 * Build the file map of generated app/* route files.
 *
 * Caller merges this with the content/* files from buildSiteContentFiles
 * before passing to publishCommit.
 */
export async function emitNextjsRoutes(
  pages: PageWithWrapper[],
  deps: EmitRoutesDeps,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  // Resolve wrappers (site-level + every assigned page-level)
  const wrapperIds = new Set<string>();
  if (deps.site.wrapper_id) wrapperIds.add(deps.site.wrapper_id);
  for (const p of pages) if (p.wrapper_id) wrapperIds.add(p.wrapper_id);

  const wrappersById = new Map<string, WrapperRow>();
  if (wrapperIds.size > 0) {
    const result = await deps.supabase
      .from('templates_wrappers')
      .select('id, name, role, component_export_path')
      .in('id', [...wrapperIds]);
    const rows = ((result as { data: WrapperRow[] | null }).data ?? []);
    for (const row of rows) wrappersById.set(row.id, row);
  }

  const siteWrapper = deps.site.wrapper_id ? wrappersById.get(deps.site.wrapper_id) : null;

  // Resolve the analytics head injection once — used by every layout we emit.
  const analyticsHeadHtml = renderAnalyticsHead(deps);

  // Resolve the A/B bootstrap script once — used by every layout. The
  // script is a no-op for pages without a binding; the per-route inline
  // call to gatewazeABBootstrap(testId, goalEvent) does the real work.
  const abBootstrapJs =
    deps.apiOrigin && deps.abTestsByRoute && Object.keys(deps.abTestsByRoute).length > 0
      ? renderAbBootstrap(deps.apiOrigin)
      : '';

  // 1. Site-level layout (only when there's a site wrapper AND at least one
  //    blocks-mode page — schema-mode pages keep their theme's layout)
  const blocksPages = pages.filter((p) => p.composition_mode === 'blocks');
  if (blocksPages.length > 0 && siteWrapper && siteWrapper.component_export_path) {
    files.set('app/layout.tsx', emitSiteLayout(siteWrapper, analyticsHeadHtml, abBootstrapJs));
  }

  // Persist the per-route A/B bindings as a static JSON file so the bootstrap
  // script can match the current pathname on the client without us emitting
  // a separate Next.js component per route. The map is small and operator-
  // controlled, so client exposure is fine.
  if (abBootstrapJs && deps.abTestsByRoute) {
    files.set('public/_gatewaze/ab-bindings.json', JSON.stringify(deps.abTestsByRoute, null, 2));
  }

  // 2. Per-page route files for blocks-mode pages
  for (const page of blocksPages) {
    const pageWrapper = page.wrapper_id ? wrappersById.get(page.wrapper_id) : null;

    // Route group syntax for page wrappers
    const routePath = pageWrapper && pageWrapper.role === 'page'
      ? `app/(${pageWrapper.name})${page.full_path === '/' ? '/(home)' : page.full_path}/page.tsx`
      : `app${page.full_path === '/' ? '/(home)' : page.full_path}/page.tsx`;

    files.set(routePath, emitBlocksPage(page, routePath));

    // Also emit a per-route-group layout if the page wrapper exists and we
    // haven't yet emitted one for this group
    if (pageWrapper && pageWrapper.role === 'page' && pageWrapper.component_export_path) {
      const layoutPath = `app/(${pageWrapper.name})/layout.tsx`;
      if (!files.has(layoutPath)) {
        files.set(layoutPath, emitPageWrapperLayout(pageWrapper));
      }
    }
  }

  deps.logger.info('emit-nextjs-routes done', {
    blocksPagesCount: blocksPages.length,
    filesEmitted: files.size,
  });

  return files;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function emitSiteLayout(
  siteWrapper: WrapperRow,
  analyticsHeadHtml: string,
  abBootstrapJs: string,
): string {
  const importPath = siteWrapper.component_export_path!.replace(/\.tsx?$/, '');
  // Both the analytics head and the A/B bootstrap script are emitted as raw
  // HTML via dangerouslySetInnerHTML so they land verbatim. All interpolated
  // strings are operator-controlled and escaped at their source.
  const headInner = [
    analyticsHeadHtml,
    abBootstrapJs ? `<script>${abBootstrapJs}</script>` : '',
  ]
    .filter(Boolean)
    .join('\n      ');
  const headBlock = headInner
    ? `<head dangerouslySetInnerHTML={{ __html: ${JSON.stringify(headInner)} }} />`
    : '';
  return `// AUTO-GENERATED by gatewaze publish — do not edit
import type { ReactNode } from 'react';
import { SiteWrapper } from '${importPath}';
import './globals.css';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      ${headBlock}
      <body>
        <SiteWrapper>{children}</SiteWrapper>
      </body>
    </html>
  );
}
`;
}

/**
 * Inline A/B bootstrap. Loads `/_gatewaze/ab-bindings.json` once, looks up
 * the current pathname, and runs the assign → impression cycle. Exposes
 * `window.gatewazeAB.recordConversion(goalEvent)` for the host page's
 * own click / submit handlers.
 *
 * Why inline rather than a separate <script src=…>: avoids one round-trip,
 * avoids needing to ship a build artifact for the snippet itself, and the
 * snippet is small (<2KB).
 */
function renderAbBootstrap(apiOrigin: string): string {
  const escOrigin = apiOrigin.replace(/\/+$/, '').replace(/'/g, "\\'");
  return `;(function(){
  if (typeof window === 'undefined') return;
  var origin = '${escOrigin}';
  var sessionKey;
  try {
    sessionKey = localStorage.getItem('gatewaze_ab_session');
    if (!sessionKey) {
      sessionKey = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
      localStorage.setItem('gatewaze_ab_session', sessionKey);
    }
  } catch (e) {
    sessionKey = Date.now() + '-' + Math.random().toString(36).slice(2);
  }
  var bindingsP = fetch('/_gatewaze/ab-bindings.json', { credentials: 'omit' })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .catch(function () { return {}; });
  var binding;
  function pathKey() {
    var p = window.location.pathname.replace(/\\/+$/, '');
    return p === '' ? '/' : p;
  }
  function post(path, body) {
    return fetch(origin + '/api/ab/' + binding.testId + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      keepalive: true,
    });
  }
  function variantSlug() {
    var p = pathKey();
    if (p === '/') return 'index';
    var parts = p.split('/').filter(Boolean);
    return parts.join('/');
  }
  function fetchVariantContent(variant) {
    // Per-variant content lives at content/pages/<slug>.<variant>.json. Next.js
    // serves it under /content/pages/<slug>.<variant>.json via the public dir;
    // the host theme reads window.gatewazeAB.variantContent and re-renders.
    var slug = variantSlug();
    return fetch('/content/pages/' + slug + '.' + variant + '.json', { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }
  bindingsP.then(function (bindings) {
    binding = bindings[pathKey()];
    if (!binding) return;
    return post('/assign', { sessionKey: sessionKey })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (out) {
        if (!out || !out.variant) return;
        document.body.setAttribute('data-ab-variant', out.variant);
        document.body.setAttribute('data-ab-test-id', binding.testId);
        post('/impression', { sessionKey: sessionKey, variant: out.variant }).catch(function () {});
        return fetchVariantContent(out.variant).then(function (variantBody) {
          window.gatewazeAB = {
            variant: out.variant,
            testId: binding.testId,
            goalEvent: binding.goalEvent,
            variantContent: variantBody && variantBody.content ? variantBody.content : null,
            recordConversion: function (goalEvent) {
              return post('/conversion', {
                sessionKey: sessionKey,
                variant: out.variant,
                goalEvent: goalEvent || binding.goalEvent,
              }).catch(function () {});
            },
          };
          window.dispatchEvent(new CustomEvent('gatewaze:ab-ready', { detail: window.gatewazeAB }));
        });
      });
  });
})();`;
}

/**
 * Compose the analytics <head> markup from the site's analytics config.
 *
 * v1: Umami only. Returns empty string when no provider is configured —
 * emitSiteLayout then omits the <head> element entirely.
 *
 * Adding plausible/fathom/ga4 follows the same shape: read the matching
 * config block, call its render helper, append.
 */
function renderAnalyticsHead(deps: EmitRoutesDeps): string {
  const tags: string[] = [];
  const analytics = deps.site.analytics;
  const umamiWebsiteId = analytics?.umami?.umamiWebsiteId;
  const umamiUrl = deps.integrations?.umamiUrl;
  if (analytics?.provider === 'umami' && umamiWebsiteId && umamiUrl) {
    const base = umamiUrl.replace(/\/+$/, '');
    const escUrl = htmlEsc(`${base}/script.js`);
    const escId = htmlEsc(umamiWebsiteId);
    tags.push(`<script defer src="${escUrl}" data-website-id="${escId}"></script>`);
  }
  return tags.join('\n      ');
}

function htmlEsc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function emitPageWrapperLayout(pageWrapper: WrapperRow): string {
  const importPath = pageWrapper.component_export_path!.replace(/\.tsx?$/, '');
  // Component export name — derive from the file path's basename, capitalized
  // (e.g. './wrappers/docs' → DocsWrapper). This matches the convention in
  // the boilerplate.
  const basename = importPath.split('/').pop() ?? 'Wrapper';
  const exportName = basename
    .split('-')
    .map((s) => s[0]?.toUpperCase() + s.slice(1))
    .join('') + (basename.endsWith('Wrapper') ? '' : 'Wrapper');

  return `// AUTO-GENERATED by gatewaze publish — do not edit
import type { ReactNode } from 'react';
import { ${exportName} } from '${importPath}';

export default function GroupLayout({ children }: { children: ReactNode }) {
  return <${exportName}>{children}</${exportName}>;
}
`;
}

function emitBlocksPage(page: PageWithWrapper, routePath: string): string {
  // Compute a relative import to the platform-emitted content file.
  // Using a relative path avoids coupling to the theme's tsconfig `@/*`
  // alias (which typically points at ./src/ — where platform-emitted
  // content/ doesn't live). The emit-nextjs-routes layer already knows
  // both the route file path and the content file path so it can do
  // the path math here once. Block-component imports stay alias-based
  // because those resolve into theme-owned code.
  const segments = routePath.split('/');
  // routePath looks like 'app/(home)/page.tsx' — minus the trailing 'page.tsx'
  // is the number of `../` hops we need to reach the repo root.
  const upCount = segments.length - 1;
  const contentPath = `${'../'.repeat(upCount)}content/pages/${page.slug}.json`;
  return `// AUTO-GENERATED by gatewaze publish — do not edit
// Renders blocks-mode page from content/pages/${page.slug}.json
import content from '${contentPath}';

interface BlockInstance {
  block_def_name: string;
  component_export_path: string | null;
  sort_order: number;
  content: Record<string, unknown>;
}

interface PageContent {
  slug: string;
  full_path: string;
  composition_mode: 'blocks';
  blocks: BlockInstance[];
}

export default async function BlocksPage() {
  const data = content as PageContent;
  // Dynamic component imports: resolved at build time by Next.js + Turbopack.
  // Each block's component_export_path is relative to the theme repo root.
  const rendered = await Promise.all(
    data.blocks.map(async (block, idx) => {
      if (!block.component_export_path) return null;
      const mod = await import(/* webpackInclude: /\\.tsx$/ */ \`@/\${block.component_export_path.replace(/^\\.\\//, '')}\`);
      const Component = mod[block.block_def_name] ?? mod.default;
      if (!Component) return null;
      return <Component key={idx} {...block.content} />;
    }),
  );
  return <>{rendered}</>;
}
`;
}
