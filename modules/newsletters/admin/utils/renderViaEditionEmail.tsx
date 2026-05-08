/**
 * Adapter-side helper: render an OutputRenderContext via EditionEmail
 * (single `await render(<EditionEmail/>)` call). Per
 * spec-builder-evaluation §3.6 (extended).
 *
 * Used by the per-format output adapters (HTML, Substack, Beehiiv)
 * when any block in the context has `render_kind='react-email'`. The
 * helper:
 *
 *   1. Reconstructs a NewsletterEdition shape from the OutputRenderContext.
 *   2. Builds the per-block BlockRenderMeta map: react-email blocks
 *      point at their registry component_id; Mustache blocks carry
 *      the resolved per-format template string.
 *   3. Calls @react-email/render once. The whole document — `<Html>`,
 *      `<Head>`, `<Preview>`, `<Body>`, MSO ghosts, inline-styled
 *      tables — comes back as one HTML string.
 *
 * Adapters retain control of post-processing (link short-URL substitution,
 * the format-specific output transformations like Substack's `<p>`
 * stripping); EditionEmail just produces the assembled HTML.
 *
 * `format` selects the per-block component variant:
 *   - 'email'     → registry's base `Component`
 *   - 'substack'  → registry entry's `formats.substack` (else falls
 *                   back to base Component)
 *   - 'beehiiv'   → registry entry's `formats.beehiiv`  (else base)
 */

import { render } from '@react-email/render';
import { EditionEmail, type BlockRenderMeta } from '../components/puck/email-blocks/EditionEmail.js';
import type { FormatId } from '../components/puck/email-blocks/registry-types.js';
import type { OutputRenderContext } from '../../types/output-adapter.js';
import type { NewsletterEdition, EditionBlock } from './types.js';

export interface RenderViaEditionEmailArgs {
  context: OutputRenderContext;
  format: 'email' | FormatId;
  /** Whether to pretty-print the HTML output (debug only — production usually false). */
  pretty?: boolean;
}

export async function renderViaEditionEmail(args: RenderViaEditionEmailArgs): Promise<string> {
  const { context, format, pretty } = args;

  // Reconstruct a NewsletterEdition. EditionEmail walks edition.blocks
  // by sort_order; the adapter has already applied any block exclusions
  // (excludedBlockTypes) before we get here.
  const edition: NewsletterEdition = {
    id: context.edition.id,
    edition_date: context.edition.edition_date,
    ...(context.edition.subject !== undefined ? { subject: context.edition.subject } : {}),
    ...(context.edition.preheader !== undefined ? { preheader: context.edition.preheader } : {}),
    blocks: context.blocks.map<EditionBlock>((b) => ({
      id: b.id,
      // EditionEmail looks at block_template.content.html_template ONLY
      // when no meta is provided. Since we always provide meta below,
      // the block_template fields are largely informational here.
      block_template: {
        id: '', // unused by EditionEmail when meta is provided
        name: b.block_type,
        block_type: b.block_type,
        content: {
          html_template: b.template,
          has_bricks: b.has_bricks,
        },
      },
      content: b.content,
      sort_order: b.sort_order,
      bricks: b.bricks.map((br) => ({
        id: br.id,
        brick_template: {
          id: '',
          name: br.brick_type,
          brick_type: br.brick_type,
          content: { html_template: br.template },
        },
        content: br.content,
        sort_order: br.sort_order,
      })),
    })),
  };

  const blockMeta = new Map<string, BlockRenderMeta>();
  for (const b of context.blocks) {
    if (b.render_kind === 'react-email' && b.component_id) {
      blockMeta.set(b.id, {
        render_kind: 'react-email',
        component_id: b.component_id,
      });
    } else {
      blockMeta.set(b.id, {
        render_kind: 'mustache',
        mustache_html: b.template,
      });
    }
  }

  return render(
    <EditionEmail edition={edition} format={format} blockMeta={blockMeta} />,
    { pretty: pretty ?? false },
  );
}

/**
 * Convenience: returns true when at least one block in the context has
 * render_kind='react-email'. Adapters use this to decide whether to take
 * the EditionEmail path or the legacy per-block Mustache path. When all
 * blocks are Mustache, adapters keep their existing behaviour bit-for-bit.
 */
export function hasReactEmailBlocks(context: OutputRenderContext): boolean {
  return context.blocks.some((b) => b.render_kind === 'react-email');
}
