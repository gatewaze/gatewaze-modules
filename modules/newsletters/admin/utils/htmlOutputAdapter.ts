/**
 * HTML Email Output Adapter
 *
 * Generates full HTML email output with:
 * - Table-based layouts for consistent email client rendering
 * - All CSS inlined via juice
 * - MSO conditionals for Outlook compatibility
 * - Preheader text for inbox preview
 * - Dark mode meta tags (light-only)
 * - Optional block comment delimiters for round-trip designer editing
 */

import { renderTemplate } from './templateParser';
import type {
  INewsletterOutputAdapter,
  OutputRenderContext,
  OutputRenderOptions,
  OutputBlock,
  OutputBrick,
} from '../../types/output-adapter';

/**
 * Generate email boilerplate for HTML email
 */
function getEmailBoilerplateStart(preheaderText: string = ''): string {
  const preheader = preheaderText
    ? `<div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${preheaderText}${'&nbsp;&zwnj;'.repeat(50)}</div>`
    : '';

  return `<!DOCTYPE html>
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
<title></title>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<!--[if mso]>
<xml><w:WordDocument xmlns:w="urn:schemas-microsoft-com:office:word"><w:DontUseAdvancedTypographyReadingMail/></w:WordDocument>
<o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch><o:AllowPNG/></o:OfficeDocumentSettings></xml>
<![endif]-->
<style>
:root{color-scheme:light only;supported-color-schemes:light only}
body{margin:0;padding:0;-webkit-text-size-adjust:none;text-size-adjust:none}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:inherit!important}
#MessageViewBody a{color:inherit;text-decoration:none}
.desktop_hide,.desktop_hide table{mso-hide:all;display:none;max-height:0;overflow:hidden}
.image_block img+div{display:none}
sub,sup{font-size:75%;line-height:0}
@media (max-width:670px){
.image_block div.fullWidth{max-width:100%!important}
.mobile_hide{display:none!important}
.row-content{width:100%!important;max-width:100%!important}
.stack .column{width:100%;display:block}
.mobile_hide{min-height:0;max-height:0;max-width:0;overflow:hidden;font-size:0}
.desktop_hide,.desktop_hide table{display:table!important;max-height:none!important}
.nl-padding{padding:5px!important}
}
</style>
</head>
<body class="body" style="background-color:#ffffff;margin:0!important;padding:0!important;-webkit-text-size-adjust:none;text-size-adjust:none">
${preheader}
<!--[if mso]><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:10px"><![endif]-->
<table class="nl-container" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace:0;mso-table-rspace:0;background-color:#ffffff" bgcolor="#ffffff">
<tbody><tr><td class="nl-padding" style="padding:10px">`;
}

const EMAIL_BOILERPLATE_END = `</td></tr></tbody></table>
<!--[if mso]></td></tr></table><![endif]-->
</body>
</html>`;

const BLOCK_SPACER = `<table class="row row-spacer" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace:0;mso-table-rspace:0">
<tbody><tr><td style="height:10px;font-size:1px;line-height:1px">&nbsp;</td></tr></tbody></table>`;

/**
 * Apply email-safe replacements to HTML
 */
function makeEmailSafe(html: string): string {
  let safe = html;

  // Remove empty paragraphs
  safe = safe.replace(/<p[^>]*>\s*<\/p>/g, '');

  // Style unordered lists
  safe = safe.replace(
    /<ul(?![^>]*style=)([^>]*)>/gi,
    '<ul style="margin:8px 0 8px 0;padding-left:20px;list-style-type:disc"$1>'
  );

  // Style list items
  safe = safe.replace(
    /<li(?![^>]*style=)([^>]*)>/gi,
    '<li style="margin:0;padding-left:0"$1>'
  );

  // Remove paragraph tags inside list items
  safe = safe.replace(/<li([^>]*)><p[^>]*>/gi, '<li$1>');
  safe = safe.replace(/<\/p><\/li>/gi, '</li>');

  // Add margin to paragraph tags
  safe = safe.replace(
    /<p\s+style="([^"]*)">/gi,
    (match, styles) => {
      if (/margin/i.test(styles)) return match;
      return `<p style="margin:0 0 12px 0;${styles}">`;
    }
  );

  // Add top margin to heading-style paragraphs
  safe = safe.replace(
    /<p\s+style="margin:0 0 12px 0;([^"]*)">\s*<strong>([^<]+)<\/strong>\s*<\/p>/gi,
    '<p style="margin:12px 0 12px 0;$1"><strong>$2</strong></p>'
  );

  // Remove Tailwind classes from links and ensure proper styling
  safe = safe.replace(
    /<a\s+([^>]*?)class="[^"]*"([^>]*?)>/gi,
    (match, before, after) => {
      const hasStyle = /style=/i.test(before + after);
      if (hasStyle) {
        const updated = (before + after).replace(
          /style="([^"]*)"/i,
          (_, existing) => {
            const cleaned = existing.replace(/color:[^;]+;?/gi, '').trim();
            return `style="color:#4086c6;text-decoration:underline;${cleaned ? cleaned + ';' : ''}"`;
          }
        );
        return `<a ${updated}>`;
      }
      return `<a style="color:#4086c6;text-decoration:underline" ${before}${after}>`;
    }
  );

  // Add styling to links without style attribute
  safe = safe.replace(/<a\s+(?![^>]*style=)href=/gi, '<a style="color:#4086c6;text-decoration:underline" href=');

  // Image improvements for email clients
  safe = safe.replace(/<img\s+(?![^>]*style=)/gi, '<img style="display:block;border:0;outline:none;max-width:100%;height:auto" ');
  safe = safe.replace(/<img\s+(?![^>]*align=)/gi, '<img align="center" ');

  // Add bgcolor to tables with background-color (for Outlook)
  safe = safe.replace(
    /<table([^>]*?)style="([^"]*?)background-color:\s*([^;"\s]+)/gi,
    '<table$1bgcolor="$3" style="$2background-color:$3'
  );

  return safe;
}

/**
 * Process HTML through juice to inline CSS, then apply email-safe fixes.
 * Juice is loaded lazily to avoid crashes when stubbed in Docker builds.
 */
let _juice: ((html: string, opts: Record<string, unknown>) => string) | null = null;
let _juiceLoaded = false;

async function loadJuice() {
  if (_juiceLoaded) return _juice;
  _juiceLoaded = true;
  try {
    // Use variable to prevent Vite's static import analysis from failing
    const pkg = 'juice';
    const mod = await import(/* @vite-ignore */ pkg);
    _juice = mod.default || mod;
  } catch {
    _juice = null;
  }
  return _juice;
}

async function processEmailHtml(html: string): Promise<string> {
  const juice = await loadJuice();
  if (juice) {
    try {
      const processed = juice(html, {
        preserveMediaQueries: true,
        preserveFontFaces: true,
        applyWidthAttributes: false,
        applyHeightAttributes: false,
        preserveImportant: true,
      });
      return makeEmailSafe(processed);
    } catch (error) {
      console.error('Error processing email HTML with juice:', error);
    }
  }
  return makeEmailSafe(html);
}

/**
 * Strip HTML tags to get plain text for preheader
 */
function stripHtmlToPlainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract preheader text from edition blocks
 */
function extractPreheaderText(blocks: OutputBlock[]): string {
  const introBlock = blocks.find(b => b.block_type === 'intro_paragraph');
  if (introBlock?.content.text) {
    return stripHtmlToPlainText(introBlock.content.text as string).slice(0, 150);
  }
  const hotTakeBlock = blocks.find(b => b.block_type === 'hot_take');
  if (hotTakeBlock?.content.body) {
    return stripHtmlToPlainText(hotTakeBlock.content.body as string).slice(0, 150);
  }
  return '';
}

/**
 * Render a single block with its template
 */
function renderBlock(block: OutputBlock, options?: OutputRenderOptions): string {
  let blockContent: Record<string, unknown> = { ...block.content };

  // Render bricks if the block has them
  if (block.has_bricks && block.bricks.length > 0) {
    const sortedBricks = [...block.bricks].sort((a, b) => a.sort_order - b.sort_order);
    const renderedBricks = sortedBricks
      .map((brick, index) => {
        let html = renderBrick(brick, options);
        // Remove trailing divider from last brick
        if (index === sortedBricks.length - 1) {
          html = html.replace(/<table class="divider_block"[^>]*>[\s\S]*?<\/table>\s*$/, '');
        }
        if (options?.includeBlockComments) {
          html = `<!-- BRICK:${brick.brick_type} -->\n${html}\n<!-- /BRICK:${brick.brick_type} -->`;
        }
        return html;
      })
      .join('');
    blockContent = { ...blockContent, bricks: renderedBricks };
  }

  let rendered = renderTemplate(block.template, blockContent);

  if (options?.includeBlockComments) {
    const attrs = block.has_bricks ? ` | has_bricks=true` : '';
    rendered = `<!-- BLOCK:${block.block_type}${attrs} -->\n${rendered}\n<!-- /BLOCK:${block.block_type} -->`;
  }

  return rendered;
}

/**
 * Render a single brick with its template
 */
function renderBrick(brick: OutputBrick, options?: OutputRenderOptions): string {
  return renderTemplate(brick.template, brick.content);
}

export const HtmlOutputAdapter: INewsletterOutputAdapter = {
  meta: {
    id: 'html',
    label: 'HTML Email',
    description: 'Full HTML email with table-based layout, inline CSS, and Outlook compatibility',
    icon: 'EnvelopeIcon',
    order: 1,
  },

  excludedBlockTypes: [],

  templateVariantKey: 'html_template',

  supportsBlockComments: true,

  async render(context: OutputRenderContext, options?: OutputRenderOptions): Promise<string> {
    const { edition, blocks } = context;

    const sortedBlocks = [...blocks].sort((a, b) => a.sort_order - b.sort_order);

    const preheaderText = edition.preheader || extractPreheaderText(sortedBlocks);

    const renderedBlocks = sortedBlocks.map(block => renderBlock(block, options));
    const blockContent = renderedBlocks.join(BLOCK_SPACER);

    const rawHtml = getEmailBoilerplateStart(preheaderText) + blockContent + EMAIL_BOILERPLATE_END;
    return processEmailHtml(rawHtml);
  },

  async postProcess(html: string): Promise<string> {
    return processEmailHtml(html);
  },
};
