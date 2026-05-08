/**
 * Export a NewsletterEdition as a complete email-safe HTML document.
 * Per spec-builder-evaluation §3.6 (extended).
 *
 * Wraps `<EditionEmail/>` + `@react-email/render` so callers (the
 * editor's "Export" button, the publish-worker's send pipeline) get
 * a single async function that turns an edition + its block-render
 * metadata into a finished HTML string.
 *
 * One render call covers the whole document — the `<Html><Head><Body>`
 * shell, MSO ghost wrappers around buttons, inline-styled tables, and
 * any legacy Mustache blocks (mounted via `dangerouslySetInnerHTML`
 * inside the same JSX tree).
 *
 * For non-email outputs (Substack, Beehiiv) pass `format: 'substack' |
 * 'beehiiv'`. EditionEmail will use each block's `formats[format]`
 * Component variant if defined, falling back to the base (email)
 * Component otherwise. The publish-worker's format-specific output
 * adapter then post-processes as needed (e.g. strips the `<Html>`
 * shell — Substack expects body-only HTML).
 */

import { render } from '@react-email/render';
import type { NewsletterEdition } from '../../../utils/types.js';
import { EditionEmail, type BlockRenderMeta } from './EditionEmail.js';
import type { FormatId } from './registry-types.js';

export interface ExportArgs {
  edition: NewsletterEdition;
  format: 'email' | FormatId;
  /**
   * Per-block render metadata indexed by EditionBlock.id. The caller
   * (editor / publish-worker) joins newsletters_edition_blocks to
   * templates_block_defs to read render_kind / component_id / the
   * format-specific Mustache template, then constructs this map.
   *
   * If a block isn't in the map, EditionEmail falls back to treating
   * it as a Mustache block with the block_template's html_template.
   */
  blockMeta: ReadonlyMap<string, BlockRenderMeta>;
  /**
   * react-email's render() options. `pretty: true` is helpful while
   * debugging; production usually wants `false` for smaller payloads.
   */
  pretty?: boolean;
}

export async function exportEditionHtml(args: ExportArgs): Promise<string> {
  return render(
    <EditionEmail
      edition={args.edition}
      format={args.format}
      blockMeta={args.blockMeta}
    />,
    { pretty: args.pretty ?? false },
  );
}
