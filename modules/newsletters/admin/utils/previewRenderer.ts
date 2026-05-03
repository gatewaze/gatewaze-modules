/**
 * Newsletter Preview Renderer
 *
 * Lightweight HTML generator for the admin preview panel.
 * Uses renderTemplate from templateParser to process Mustache templates.
 * Does NOT use juice or heavy CSS inlining — the preview iframe handles display.
 *
 * For production email output (with juice, MSO conditionals, etc.),
 * use the newsletters-output-html module's adapter instead.
 */

import { renderTemplate } from './templateParser';
import { resolveStoragePathsInJson } from '@gatewaze/shared';
import type { NewsletterEdition, EditionBlock, OutputFormat } from './types';

/**
 * Generate newsletter HTML for preview purposes.
 *
 * For 'html' format: renders block HTML templates with basic wrapper.
 * For 'substack'/'beehiiv' format: renders rich text templates (falling back to HTML).
 */
export function generateNewsletterHtml(
  edition: NewsletterEdition,
  format: OutputFormat = 'html',
  boilerplate?: { start: string; end: string },
  /**
   * Effective storage bucket URL (from BrandConfig.storageBucketUrl). When provided,
   * any relative storage paths in block/brick content are resolved to full URLs
   * before rendering. See spec-relative-storage-paths.md.
   */
  storageBucketUrl?: string
): string {
  const useRichText = format === 'substack' || format === 'beehiiv';
  const blocksHtml = edition.blocks
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((block) => renderBlock(block, useRichText, storageBucketUrl))
    .join('\n');

  if (useRichText) {
    return blocksHtml;
  }

  // If we have the original template boilerplate, use it
  if (boilerplate?.start || boilerplate?.end) {
    return `${boilerplate.start}\n${blocksHtml}\n${boilerplate.end}`;
  }

  // Fallback: wrap in basic email-like HTML for the preview
  const preheader = edition.preheader
    ? `<div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${edition.preheader}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${edition.subject || 'Newsletter'}</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;">
<tr><td align="center" style="padding:20px 0;">
<table role="presentation" width="650" cellpadding="0" cellspacing="0" style="background-color:#ffffff;max-width:650px;width:100%;">
<tr><td style="padding:0;">
${blocksHtml}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * Render a single block, including its bricks
 */
function renderBlock(block: EditionBlock, useRichText: boolean, storageBucketUrl?: string): string {
  const blockContent = block.block_template.content || {};

  // Build brick HTML first so it can be injected as {{bricks}}
  const bricksHtml = block.bricks
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((brick) => {
      const brickContent = brick.brick_template.content || {};
      const template = useRichText
        ? brickContent.rich_text_template || brickContent.html_template
        : brickContent.html_template;
      // Resolve any relative storage paths in the brick content before templating.
      const resolvedBrickContent = storageBucketUrl
        ? resolveStoragePathsInJson(brick.content, storageBucketUrl)
        : brick.content;
      return renderTemplate(template || '', resolvedBrickContent as Record<string, unknown>);
    })
    .join('\n');

  const template = useRichText
    ? blockContent.rich_text_template || blockContent.html_template
    : blockContent.html_template;

  // Resolve relative storage paths in block content.
  const resolvedBlockContent = storageBucketUrl
    ? (resolveStoragePathsInJson(block.content, storageBucketUrl) as Record<string, unknown>)
    : (block.content as Record<string, unknown>);

  // Inject bricks content and edition-level data into the block's content context
  const context: Record<string, unknown> = {
    ...resolvedBlockContent,
    bricks: bricksHtml,
  };

  return renderTemplate(template || '', context);
}
