import { describe, expect, it, vi } from 'vitest';
import { emitNextjsRoutes, type PageWithWrapper } from '../emit-nextjs-routes.js';

interface WrapperRow {
  id: string;
  name: string;
  role: 'site' | 'page';
  component_export_path: string | null;
}

function makeStubDeps(opts: { wrappers?: WrapperRow[]; siteWrapperId?: string | null } = {}) {
  return {
    supabase: {
      from(_table: string) {
        return {
          select: () => ({
            in: async () => ({ data: opts.wrappers ?? [], error: null }),
          }),
        };
      },
    },
    site: { id: 'site-1', wrapper_id: opts.siteWrapperId ?? null },
    logger: { info: vi.fn(), warn: vi.fn() },
  };
}

describe('emitNextjsRoutes', () => {
  it('emits no files when no blocks-mode pages', async () => {
    const pages: PageWithWrapper[] = [
      { slug: 'home', full_path: '/', wrapper_id: null, composition_mode: 'schema' },
    ];
    const deps = makeStubDeps();
    const files = await emitNextjsRoutes(pages, deps);
    expect(files.size).toBe(0);
  });

  it('emits app/layout.tsx when site has wrapper + blocks-mode pages', async () => {
    const pages: PageWithWrapper[] = [
      { slug: 'home', full_path: '/', wrapper_id: null, composition_mode: 'blocks' },
    ];
    const deps = makeStubDeps({
      wrappers: [{ id: 'sw-1', name: 'site', role: 'site', component_export_path: './wrappers/site' }],
      siteWrapperId: 'sw-1',
    });
    const files = await emitNextjsRoutes(pages, deps);
    expect(files.has('app/layout.tsx')).toBe(true);
    const layoutContent = files.get('app/layout.tsx')!;
    expect(layoutContent).toContain('SiteWrapper');
    expect(layoutContent).toContain("from './wrappers/site'");
  });

  it('emits app/<full_path>/page.tsx for each blocks-mode page', async () => {
    const pages: PageWithWrapper[] = [
      { slug: 'about', full_path: '/about', wrapper_id: null, composition_mode: 'blocks' },
      { slug: 'pricing', full_path: '/pricing', wrapper_id: null, composition_mode: 'blocks' },
    ];
    const deps = makeStubDeps();
    const files = await emitNextjsRoutes(pages, deps);
    expect(files.has('app/about/page.tsx')).toBe(true);
    expect(files.has('app/pricing/page.tsx')).toBe(true);
  });

  it('home page (full_path /) emits to app/(home)/page.tsx (avoids root collision)', async () => {
    const pages: PageWithWrapper[] = [
      { slug: 'home', full_path: '/', wrapper_id: null, composition_mode: 'blocks' },
    ];
    const deps = makeStubDeps();
    const files = await emitNextjsRoutes(pages, deps);
    expect(files.has('app/(home)/page.tsx')).toBe(true);
  });

  it('emits route group + layout for pages with a page wrapper', async () => {
    const pages: PageWithWrapper[] = [
      { slug: 'getting-started', full_path: '/docs/getting-started', wrapper_id: 'pw-docs', composition_mode: 'blocks' },
      { slug: 'api', full_path: '/docs/api', wrapper_id: 'pw-docs', composition_mode: 'blocks' },
    ];
    const deps = makeStubDeps({
      wrappers: [{ id: 'pw-docs', name: 'docs', role: 'page', component_export_path: './wrappers/docs' }],
    });
    const files = await emitNextjsRoutes(pages, deps);
    // Both pages routed inside (docs) group
    expect(files.has('app/(docs)/docs/getting-started/page.tsx')).toBe(true);
    expect(files.has('app/(docs)/docs/api/page.tsx')).toBe(true);
    // Wrapper layout emitted once
    expect(files.has('app/(docs)/layout.tsx')).toBe(true);
    const layoutContent = files.get('app/(docs)/layout.tsx')!;
    expect(layoutContent).toContain('DocsWrapper');
  });

  it('blocks-mode page references its content/<slug>.json sibling', async () => {
    const pages: PageWithWrapper[] = [
      { slug: 'about', full_path: '/about', wrapper_id: null, composition_mode: 'blocks' },
    ];
    const deps = makeStubDeps();
    const files = await emitNextjsRoutes(pages, deps);
    const content = files.get('app/about/page.tsx')!;
    expect(content).toContain("import content from '@/content/pages/about.json'");
    expect(content).toContain('PageContent');
  });
});
