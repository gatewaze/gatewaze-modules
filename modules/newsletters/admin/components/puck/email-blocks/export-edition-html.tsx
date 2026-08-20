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

/**
 * Move any `<style>` blocks out of the message body and into `<head>`.
 *
 * The declarative wrapper renders its dark-mode `<style>` as the first element
 * of the body (react-email nests it deep inside `<body><table>…<td><style>`).
 * Gmail chokes on a `<style>` embedded in the body: it clips the message
 * ("[Message clipped] View entire message") regardless of size — a 13KB Style C
 * edition clipped while a 50KB+ classic edition (no `<style>`) did not. CSS
 * belongs in `<head>` anyway, and Gmail handles a head `<style>` normally, so we
 * hoist every body `<style>` up before `</head>`. Selectors are global either
 * way, so dark-mode behaviour is unchanged (if anything, better supported).
 *
 * Pure string surgery on the already-rendered document: split at `</head>`, pull
 * `<style>…</style>` out of everything after it, and re-insert before `</head>`.
 * Anything in the head (there is no author `<style>` there) is untouched.
 */
function hoistStyleToHead(html: string): string {
  const headEnd = html.indexOf('</head>');
  if (headEnd === -1) return html;
  const head = html.slice(0, headEnd); // up to, not including, </head>
  const rest = html.slice(headEnd); // </head> … </html> (the body)
  const styles: string[] = [];
  const bodyWithoutStyles = rest.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => {
    styles.push(m);
    return '';
  });
  if (styles.length === 0) return html;
  return head + styles.join('') + bodyWithoutStyles;
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
  return hoistStyleToHead(html);
}
