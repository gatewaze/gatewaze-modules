/**
 * Page rendering composition (per spec-sites-module §6.5 + §6.6).
 *
 * Render path for legacy block-list pages (host_kind in newsletter/event/calendar).
 * Sites are uniformly website-kind and use the schema-driven renderer instead.
 *
 *   1. For each block (sorted by sort_order):
 *      a. Render bricks: substitute brick_def.html_template against
 *         each brick's content jsonb
 *      b. Substitute block_def.html_template against block's content,
 *         providing `bricks` as the rendered brick HTML array
 *   2. Substitute wrapper_def.html_template against the page-level view
 *      (page.title, site.config, etc.), providing `page_body` as the
 *      composed block HTML.
 *
 * Each substitution is a single `substitute()` call; the renderer pre-builds
 * the per-block view + assembles the wrapper view as the final step. This
 * file is pure — no DB, no I/O. The caller is responsible for hydrating the
 * inputs via Supabase.
 */

import type { PageRow, PageBlockRow, PageBlockBrickRow, SiteRow } from '../../types/index.js';
import { substitute, type View } from './substitute.js';

export interface BlockDef {
  id: string;
  /** Mustache HTML template body (may contain `{{#bricks}}...{{/bricks}}`). */
  html_template: string;
}

export interface BrickDef {
  id: string;
  html_template: string;
}

export interface WrapperDef {
  id: string;
  /** Top-level wrapper template; references `{{>page_body}}` to inject the composed blocks. */
  html_template: string;
}

export interface RenderInput {
  page: Pick<PageRow, 'id' | 'title' | 'full_path' | 'seo' | 'host_kind' | 'host_id'>;
  site: Pick<SiteRow, 'id' | 'slug' | 'name' | 'config'> | null;
  wrapper: WrapperDef;
  blocks: Array<{
    block: Pick<PageBlockRow, 'id' | 'sort_order' | 'content' | 'variant_key'>;
    blockDef: BlockDef;
    bricks: Array<{
      brick: Pick<PageBlockBrickRow, 'id' | 'sort_order' | 'content' | 'variant_key'>;
      brickDef: BrickDef;
    }>;
  }>;
}

export interface RenderOutput {
  html: string;
  /**
   * Stats useful for telemetry: number of blocks rendered, total bricks
   * rendered, count of `{{>page_body}}` partials substituted (sanity).
   */
  stats: {
    blocksRendered: number;
    bricksRendered: number;
  };
}

/**
 * Render a page to a complete HTML document.
 *
 * Throws if the wrapper template lacks the `{{>page_body}}` reference (the
 * lint should have already caught this; defensive at render time).
 */
export function renderPage(input: RenderInput): RenderOutput {
  let bricksRendered = 0;
  const blocksHtml: string[] = [];

  // Sort blocks defensively — caller should already have sorted, but cheap.
  const sortedBlocks = [...input.blocks].sort((a, b) => a.block.sort_order - b.block.sort_order);

  for (const { block, blockDef, bricks } of sortedBlocks) {
    // Render bricks first (their HTML is the value of `{{#bricks}}…` /
    // `bricks` array in the block view).
    const sortedBricks = [...bricks].sort((a, b) => a.brick.sort_order - b.brick.sort_order);
    const renderedBricks = sortedBricks.map(({ brick, brickDef }) => {
      const view = brick.content as View;
      const html = substitute(brickDef.html_template, view);
      return { brickId: brick.id, html };
    });
    bricksRendered += renderedBricks.length;

    const blockView: View = {
      ...(block.content as View),
      bricks: renderedBricks.map((b) => ({ html: b.html, id: b.brickId })),
    };
    blocksHtml.push(substitute(blockDef.html_template, blockView));
  }

  const composedBody = blocksHtml.join('\n');
  const wrapperView: View = {
    page: {
      id: input.page.id,
      title: input.page.title,
      full_path: input.page.full_path,
      seo: input.page.seo,
    },
    site: input.site
      ? { id: input.site.id, slug: input.site.slug, name: input.site.name, config: input.site.config }
      : null,
  };

  if (!input.wrapper.html_template.includes('{{>page_body}}') &&
      !input.wrapper.html_template.includes('{{> page_body}}')) {
    throw new Error('wrapper_missing_page_body_partial: templates lint should have caught this');
  }

  const html = substitute(input.wrapper.html_template, wrapperView, {
    partials: { page_body: composedBody },
  });

  return {
    html,
    stats: {
      blocksRendered: sortedBlocks.length,
      bricksRendered,
    },
  };
}
