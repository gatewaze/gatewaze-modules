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
import type { EmailBlockRegistry } from './registry-types.js';
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
   * Declarative wrapper template HTML from the newsletter's repo
   * (`templates_wrappers.html`, key='default'). When present, the body blocks
   * render inside the wrapper's `<slot name="body" />`.
   */
  wrapperTemplate?: string | null;
  /** Resolved "View Online" URL for the header link (default `{{web_version}}`). */
  viewOnlineUrl?: string;
  /** Suppress the header "View Online" link (set when rendering for the
   *  publish branch — the page is already the online version). */
  hideViewOnline?: boolean;
  /** Per-edition registry (code + declarative blocks) for export-side lookup. */
  registry?: EmailBlockRegistry;
  /**
   * react-email's render() options. `pretty: true` is helpful while
   * debugging; production usually wants `false` for smaller payloads.
   */
  pretty?: boolean;
  /**
   * Forwarded to EditionEmail. When true the wrapper footer's
   * Subscription Centre fields land the per-recipient {{...}} tokens for the
   * send pipeline to substitute. Caller MUST set this to true on the path
   * that feeds newsletter-send (the editor's getRenderedHtml callback);
   * publish / canvas-preview renders leave it false / omitted. See the
   * `forSend` doc on EditionEmailProps for the full chain.
   */
  forSend?: boolean;
}

// Zero-width non-joiner (U+200C): invisible, non-Latin-1, harmless.
const UTF8_MARKER = "\u200c";
// Matches any character OUTSIDE Latin-1 (> U+00FF), i.e. one that forces a
// UTF-8 encoding. eslint-disable: the control-char range is intentional.
// eslint-disable-next-line no-control-regex
const NON_LATIN1 = /[^\u0000-\u00ff]/;

/**
 * Guarantee the document is encoded as UTF-8 by the sender.
 *
 * SendGrid (and mailers generally) pick the MIME charset from the CONTENT
 * BYTES: a document that fits entirely in Latin-1 is sent as
 * `text/html; charset=iso-8859-1`, and **Gmail clips iso-8859-1 messages**
 * ("[Message clipped] View entire message") regardless of size — a 13KB Style C
 * edition clipped while a 50KB+ utf-8 edition did not. (Adding a preheader
 * incidentally fixed it, because react-email's `<Preview>` padding is full of
 * UTF-8 zero-width characters.)
 *
 * We force UTF-8 deterministically by ensuring at least one non-Latin-1 byte:
 * an invisible zero-width non-joiner in a hidden span right after `<body>`.
 * Only injected when the document is otherwise pure-Latin-1, so any edition
 * that already contains a UTF-8 character (a smart quote, an emoji, a
 * preheader) is returned byte-for-byte unchanged. One character — so, unlike a
 * full `<Preview>` block, it does not blank out the inbox preview.
 */
function ensureUtf8Charset(html: string): string {
  if (NON_LATIN1.test(html)) return html;
  const marker = `<span style="display:none;max-height:0;overflow:hidden">${UTF8_MARKER}</span>`;
  return html.replace(/(<body\b[^>]*>)/i, `$1${marker}`);
}

export async function exportEditionHtml(args: ExportArgs): Promise<string> {
  const html = await render(
    <EditionEmail
      edition={args.edition}
      format={args.format}
      blockMeta={args.blockMeta}
      wrapperTemplate={args.wrapperTemplate}
      viewOnlineUrl={args.viewOnlineUrl}
      hideViewOnline={args.hideViewOnline}
      registry={args.registry}
      forSend={args.forSend}
    />,
    { pretty: args.pretty ?? false },
  );
  return ensureUtf8Charset(html);
}
