/**
 * Newsletter HTML Generator
 *
 * Generates newsletter HTML for multiple platforms:
 * - Customer.io: Full HTML with table-based layout and inline styles
 * - Substack: Simplified semantic HTML for rich text paste
 * - Beehiiv: Simplified semantic HTML for rich text paste
 *
 * Email HTML Best Practices Applied:
 * - Table-based layouts for consistent rendering
 * - All CSS is inline (no external stylesheets)
 * - MSO conditionals for Outlook compatibility
 * - Explicit font-family declarations on all text
 * - Width attributes on tables (not just CSS)
 * - cellpadding/cellspacing/border attributes
 * - role="presentation" on layout tables
 */

import juice from 'juice';
import { getShortLinkDomain, getNewsletterConfig } from '@/config/brands';
import { renderTemplate } from './templateParser';

export type OutputFormat = 'customerio' | 'substack' | 'beehiiv';

export interface BlockTemplate {
  id: string;
  name: string;
  block_type: string;
  html_template: string;
  rich_text_template: string | null;
  has_bricks: boolean;
  schema: Record<string, unknown>;
}

export interface BrickTemplate {
  id: string;
  name: string;
  brick_type: string;
  html_template: string;
  rich_text_template: string | null;
  schema: Record<string, unknown>;
}

export interface EditionBlock {
  id: string;
  block_template: BlockTemplate;
  content: Record<string, unknown>;
  sort_order: number;
  bricks: EditionBrick[];
}

export interface EditionBrick {
  id: string;
  brick_template: BrickTemplate;
  content: Record<string, unknown>;
  sort_order: number;
}

export interface NewsletterEdition {
  id: string;
  edition_date: string;
  subject?: string;
  preheader?: string;
  blocks: EditionBlock[];
}

/**
 * Generate email boilerplate for Customer.io
 * Includes preheader text support and dark mode meta tags
 */
function getCustomerioBoilerplateStart(preheaderText: string = ''): string {
  // Preheader is the preview text shown in inbox - pad with spaces to prevent content from showing
  const preheader = preheaderText
    ? `<div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${preheaderText}${'&nbsp;&zwnj;'.repeat(50)}</div>`
    : '';

  return `<!DOCTYPE html>
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
<title></title>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- Force light mode only -->
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

const CUSTOMERIO_BOILERPLATE_END = `</td></tr></tbody></table>
<!--[if mso]></td></tr></table><![endif]-->
</body>
</html>`;

/**
 * Block types to exclude from Substack/Beehiiv output
 * These platforms have their own header/footer and we don't need promotional blocks
 */
const RICH_TEXT_EXCLUDED_BLOCKS = ['header', 'footer', 'how_we_can_help'];

/**
 * Generate newsletter HTML for a specific output format
 */
export function generateNewsletterHtml(
  edition: NewsletterEdition,
  format: OutputFormat
): string {
  // Sort blocks by sort_order
  let sortedBlocks = [...edition.blocks].sort((a, b) => a.sort_order - b.sort_order);

  // For Substack/Beehiiv, filter out header, footer, and how_we_can_help blocks
  if (format === 'substack' || format === 'beehiiv') {
    sortedBlocks = sortedBlocks.filter(
      block => !RICH_TEXT_EXCLUDED_BLOCKS.includes(block.block_template.block_type)
    );
  }

  // Use custom preheader if provided, otherwise extract from intro_paragraph
  const preheaderText = edition.preheader || extractPreheaderText(sortedBlocks);

  // Render each block, passing edition_date for header block
  const renderedBlocks = sortedBlocks.map(block => renderBlock(block, format, edition.edition_date));

  // Join blocks with spacer
  const blockContent = renderedBlocks.join(getBlockSpacer(format));

  // Wrap in boilerplate for Customer.io
  if (format === 'customerio') {
    const rawHtml = getCustomerioBoilerplateStart(preheaderText) + blockContent + CUSTOMERIO_BOILERPLATE_END;
    // Process with juice to ensure all CSS is inlined (especially from rich text content)
    return processEmailHtml(rawHtml);
  }

  // For Substack and Beehiiv, return clean semantic HTML
  return wrapRichTextOutput(blockContent, format);
}

/**
 * Extract preheader text from the intro paragraph or first text block
 * This shows as preview text in email inboxes
 */
function extractPreheaderText(blocks: EditionBlock[]): string {
  // Look for intro_paragraph block first
  const introBlock = blocks.find(b => b.block_template.block_type === 'intro_paragraph');
  if (introBlock && introBlock.content.text) {
    return stripHtmlToPlainText(introBlock.content.text as string).slice(0, 150);
  }

  // Fall back to hot_take body
  const hotTakeBlock = blocks.find(b => b.block_template.block_type === 'hot_take');
  if (hotTakeBlock && hotTakeBlock.content.body) {
    return stripHtmlToPlainText(hotTakeBlock.content.body as string).slice(0, 150);
  }

  return '';
}

/**
 * Strip HTML tags and decode entities to get plain text
 */
function stripHtmlToPlainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')  // Remove HTML tags
    .replace(/&nbsp;/g, ' ')   // Replace nbsp
    .replace(/&amp;/g, '&')    // Decode amp
    .replace(/&lt;/g, '<')     // Decode lt
    .replace(/&gt;/g, '>')     // Decode gt
    .replace(/&quot;/g, '"')   // Decode quotes
    .replace(/&#39;/g, "'")    // Decode apostrophe
    .replace(/\s+/g, ' ')      // Collapse whitespace
    .trim();
}

/**
 * Process HTML through juice to inline any CSS and fix email compatibility issues
 * This is especially important for user-entered rich text content which may contain
 * CSS classes or <style> blocks from the rich text editor
 */
function processEmailHtml(html: string): string {
  try {
    // Use juice to inline all CSS
    const processed = juice(html, {
      // Preserve media queries in <style> for responsive email
      preserveMediaQueries: true,
      // Preserve font-face rules
      preserveFontFaces: true,
      // Remove width and height attributes on images (we use inline styles)
      applyWidthAttributes: false,
      applyHeightAttributes: false,
      // Preserve important declarations
      preserveImportant: true,
    });

    // Apply email-safe replacements
    return makeEmailSafe(processed);
  } catch (error) {
    console.error('Error processing email HTML with juice:', error);
    // Return original HTML if juice fails
    return makeEmailSafe(html);
  }
}

/**
 * Apply email-safe replacements to HTML
 * Fixes common issues that cause rendering problems in email clients
 */
function makeEmailSafe(html: string): string {
  let safe = html;

  // Fix common TipTap/ProseMirror output issues - remove empty paragraphs (with or without attributes)
  safe = safe.replace(/<p[^>]*>\s*<\/p>/g, '');

  // Style unordered lists - add top margin for space after preceding paragraph, bottom margin for space before next content
  safe = safe.replace(
    /<ul(?![^>]*style=)([^>]*)>/gi,
    '<ul style="margin:8px 0 8px 0;padding-left:20px;list-style-type:disc"$1>'
  );

  // Style list items - minimal spacing between bullets
  safe = safe.replace(
    /<li(?![^>]*style=)([^>]*)>/gi,
    '<li style="margin:0;padding-left:0"$1>'
  );

  // Remove paragraph tags inside list items (TipTap wraps content in <p> tags with attributes)
  safe = safe.replace(/<li([^>]*)><p[^>]*>/gi, '<li$1>');
  safe = safe.replace(/<\/p><\/li>/gi, '</li>');

  // Add margin to paragraph tags that don't have margin already set
  // This handles TipTap content with <p style="text-align: left;"> etc
  // Use margin-bottom for spacing between paragraphs
  safe = safe.replace(
    /<p\s+style="([^"]*)">/gi,
    (match, styles) => {
      // If margin is already set, don't modify
      if (/margin/i.test(styles)) {
        return match;
      }
      // Add margin with bottom spacing for paragraph gaps
      return `<p style="margin:0 0 12px 0;${styles}">`;
    }
  );

  // Add top margin to heading-style paragraphs (paragraphs containing only <strong> text)
  // These are often used as section headings like "Responsibilities" and need space above
  safe = safe.replace(
    /<p\s+style="margin:0 0 12px 0;([^"]*)">\s*<strong>([^<]+)<\/strong>\s*<\/p>/gi,
    '<p style="margin:12px 0 12px 0;$1"><strong>$2</strong></p>'
  );

  // Remove Tailwind classes from links (they don't work in email) and ensure proper styling
  // First, handle links with class attribute - remove class and add/update style
  safe = safe.replace(
    /<a\s+([^>]*?)class="[^"]*"([^>]*?)>/gi,
    (match, before, after) => {
      // Check if there's already a style attribute
      const hasStyle = /style=/i.test(before + after);
      if (hasStyle) {
        // Replace existing style to ensure correct color
        const updated = (before + after).replace(
          /style="([^"]*)"/i,
          (_, existing) => {
            // Remove any existing color and add our color
            const cleaned = existing.replace(/color:[^;]+;?/gi, '').trim();
            return `style="color:#4086c6;text-decoration:underline;${cleaned ? cleaned + ';' : ''}"`;
          }
        );
        return `<a ${updated}>`;
      }
      return `<a style="color:#4086c6;text-decoration:underline" ${before}${after}>`;
    }
  );

  // Add styling to links that don't have style attribute (and weren't caught above)
  safe = safe.replace(/<a\s+(?![^>]*style=)href=/gi, '<a style="color:#4086c6;text-decoration:underline" href=');

  // Image improvements for email clients - only for images without style
  safe = safe
    .replace(/<img\s+(?![^>]*style=)/gi, '<img style="display:block;border:0;outline:none;max-width:100%;height:auto" ');

  // Add align="center" to images that don't have align attribute
  safe = safe.replace(/<img\s+(?![^>]*align=)/gi, '<img align="center" ');

  // Add bgcolor attribute to tables with background-color style (for Outlook)
  safe = safe.replace(
    /<table([^>]*?)style="([^"]*?)background-color:\s*([^;"\s]+)/gi,
    '<table$1bgcolor="$3" style="$2background-color:$3'
  );

  return safe;
}

/**
 * Render a single block
 */
function renderBlock(block: EditionBlock, format: OutputFormat, editionDate?: string): string {
  const { block_template, content, bricks } = block;

  // Choose template based on format
  const template = format === 'customerio'
    ? block_template.html_template
    : (block_template.rich_text_template || generateRichTextTemplate(block_template));

  // If block has bricks, render them and include in content
  let blockContent = { ...content };

  // For header block, use the edition date from the newsletter configuration
  if (block_template.block_type === 'header' && editionDate) {
    blockContent.edition_date = formatNewsletterDate(editionDate);
  }

  // For job_of_week block, compute the header title and add isLast flag to each job
  if (block_template.block_type === 'job_of_week') {
    const jobs = blockContent.jobs as Array<Record<string, unknown>> | undefined;
    const jobCount = jobs?.length || 0;
    blockContent.header_title = jobCount > 1 ? 'Jobs of the week' : 'Job of the week';
    // Add isLast flag to each job for conditional divider rendering
    if (jobs && jobs.length > 0) {
      blockContent.jobs = jobs.map((job, index) => ({
        ...job,
        isLast: index === jobs.length - 1,
      }));
    }
  }
  if (block_template.has_bricks && bricks.length > 0) {
    const sortedBricks = bricks.sort((a, b) => a.sort_order - b.sort_order);
    const renderedBricks = sortedBricks
      .map((brick, index) => {
        let html = renderBrick(brick, format);
        // Remove trailing divider from the last brick
        if (index === sortedBricks.length - 1) {
          // For Customer.io format, remove the divider_block table
          html = html.replace(/<table class="divider_block"[^>]*>[\s\S]*?<\/table>\s*$/, '');
          // For rich text format, remove the trailing hr
          html = html.replace(/<hr[^>]*>\s*$/, '');
        }
        return html;
      })
      .join('');

    blockContent = { ...blockContent, bricks: renderedBricks };
  }

  return renderTemplate(template, blockContent);
}

/**
 * Render a single brick
 */
function renderBrick(brick: EditionBrick, format: OutputFormat): string {
  const { brick_template, content } = brick;

  // Choose template based on format
  const template = format === 'customerio'
    ? brick_template.html_template
    : (brick_template.rich_text_template || generateRichTextBrickTemplate(brick_template));

  return renderTemplate(template, content);
}

// Standard font sizes for newsletter HTML
// Section label: 12px, uppercase, brand color
// Block title (h2): 24px, bold
// Brick title (h3): 20px, bold
// Body text: 16px
// Links: brand color #4086c6

/**
 * Generate a rich text template from an HTML template
 * This creates simplified semantic HTML for Substack/Beehiiv
 */
function generateRichTextTemplate(blockTemplate: BlockTemplate): string {
  const { block_type, name } = blockTemplate;

  // Generate simplified templates based on block type
  switch (block_type) {
    case 'header':
      return `<p style="text-align: center; font-size: 16px; color: #4086c6;">
<a href="{{shop_link}}" style="color: #4086c6;">Shop</a> // <a href="#" style="color: #4086c6;">View Online</a>
</p>
<p style="text-align: center; font-size: 16px; color: #4086c6;">{{edition_date}}</p>
<p style="text-align: center; font-size: 12px; color: #4086c6;">Forwarded this email? <a href="{{subscribe_link}}" style="color: #4086c6;">Subscribe here</a></p>
<hr>`;

    case 'intro_paragraph':
      return `<div style="font-size: 16px; line-height: 1.5; color: #555;">{{text}}</div>
<hr>`;

    case 'hot_take':
      return `<p style="color: #4086c6; font-size: 12px; text-transform: uppercase; margin-bottom: 8px;"><strong>HOT TAKE</strong></p>
<h2 style="font-size: 24px; font-weight: bold; color: #333; margin: 0 0 16px 0;">{{title}}</h2>
<div style="font-size: 16px; line-height: 1.5; color: #555;">{{body}}</div>
{{#poll_option_1_label}}
<p style="margin-top: 16px;">
<a href="{{poll_option_1_link}}" style="background-color: #4086c6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; margin-right: 10px; font-size: 16px;"><strong>{{poll_option_1_label}}</strong></a>
<a href="{{poll_option_2_link}}" style="background-color: #4086c6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; font-size: 16px;"><strong>{{poll_option_2_label}}</strong></a>
</p>
{{/poll_option_1_label}}
<hr>`;

    case 'last_weeks_take':
      return `<p style="color: #4086c6; font-size: 12px; text-transform: uppercase; margin-bottom: 8px;"><strong>LAST WEEK'S TAKE</strong></p>
<h2 style="font-size: 24px; font-weight: bold; color: #333; margin: 0 0 16px 0;">{{title}}</h2>
<div style="font-size: 16px; line-height: 1.5; color: #555;">{{body}}</div>
<hr>`;

    case 'sponsored_ad':
      return `<p style="color: #4086c6; font-size: 12px; text-transform: uppercase; margin-bottom: 8px;"><strong>PRESENTED BY {{sponsor_name}}</strong></p>
<h2 style="font-size: 24px; font-weight: bold; color: #333; margin: 0 0 16px 0;">{{headline}}</h2>
{{#image_url}}<p><a href="{{image_link}}"><img src="{{image_url}}" alt="" style="max-width: 100%;"></a></p>{{/image_url}}
<div style="font-size: 16px; line-height: 1.5; color: #555;">{{body}}</div>
{{#cta_text}}<p style="margin-top: 16px;"><strong><a href="{{cta_link}}" style="color: #4086c6; font-size: 16px;">{{cta_text}}</a></strong></p>{{/cta_text}}
<hr>`;

    case 'hidden_gems':
      return `<p style="color: #4086c6; font-size: 12px; text-transform: uppercase; margin-bottom: 8px;"><strong>HIDDEN GEMS</strong></p>
<h2 style="font-size: 24px; font-weight: bold; color: #333; margin: 0 0 16px 0;">{{title}}</h2>
{{#gems}}
<p style="font-size: 16px; line-height: 1.5; color: #555;"><a href="{{link_url}}" style="color: #4086c6;"><strong>{{link_text}}</strong></a> {{description}}</p>
{{/gems}}
<hr>`;

    case 'mlops_community':
      return `<p style="color: #4086c6; font-size: 12px; text-transform: uppercase; margin-bottom: 8px;"><strong>COMMUNITY</strong></p>
{{bricks}}
<hr>`;

    case 'meme_of_week':
      return `<p style="color: #4086c6; font-size: 12px; text-transform: uppercase; margin-bottom: 8px;"><strong>MEME OF THE WEEK</strong></p>
<p><img src="{{image_url}}" alt="" style="max-width: 100%;"></p>
<hr>`;

    case 'ml_confessions':
      return `<p style="color: #4086c6; font-size: 12px; text-transform: uppercase; margin-bottom: 8px;"><strong>ML CONFESSIONS</strong></p>
<h2 style="font-size: 24px; font-weight: bold; color: #333; margin: 0 0 16px 0;">{{title}}</h2>
<div style="font-size: 16px; line-height: 1.5; color: #555;">{{story}}</div>
<p style="font-size: 16px; margin-top: 16px;">Share your confession <strong><a href="{{confess_link}}" style="color: #4086c6;">here</a>.</strong></p>
<hr>`;

    case 'how_we_help':
      // Static content - no editable fields
      return `<p style="color: #4086c6; font-size: 12px; text-transform: uppercase; margin-bottom: 8px;"><strong>HOW WE CAN HELP</strong></p>
<h2 style="font-size: 24px; font-weight: bold; color: #333; margin: 0 0 16px 0;">Making the hard stuff simpler</h2>
<p style="font-size: 16px; line-height: 1.5; color: #555;">Working on something tricky or planning ahead? Here's how we can help - just hit reply:</p>
<ul style="font-size: 16px; line-height: 1.5; color: #555;">
<li>Custom workshops tailored to your company's needs</li>
<li>Hiring? I know some quality folks looking for a new adventure</li>
<li>Want to connect with someone tackling similar problems? I can introduce you</li>
</ul>
<p style="font-size: 16px; line-height: 1.5; color: #555;">Thanks for reading, catch you next time!</p>
<hr>`;

    case 'agent_infrastructure':
      return `<p style="color: #4086c6; font-size: 12px; text-transform: uppercase; margin-bottom: 8px;"><strong>AGENT INFRASTRUCTURE</strong></p>
<h2 style="font-size: 24px; font-weight: bold; color: #333; margin: 0 0 16px 0;">{{title}}</h2>
<div style="font-size: 16px; line-height: 1.5; color: #555;">{{body}}</div>
{{#useful_links.length}}
<hr>
<h3 style="font-size: 20px; font-weight: bold; color: #333; margin: 16px 0 12px 0;">Useful links</h3>
{{#useful_links}}
<p style="font-size: 16px; line-height: 1.5; color: #555;"><strong><a href="{{url}}" style="color: #4086c6;">{{title}}</a></strong>{{#description}} - {{description}}{{/description}}</p>
{{/useful_links}}
{{/useful_links.length}}
<hr>`;

    case 'job_of_week':
      return `<p style="font-size: 17px; font-weight: bold; color: #000; margin-bottom: 16px;">💡{{header_title}}</p>
{{#jobs}}
<p style="font-size: 16px; line-height: 1.5; color: #555;"><strong><a href="{{apply_link}}" style="color: #4086c6;">{{job_title}}</a> // {{company}}{{#location}} ({{location}}){{/location}}</strong></p>
{{#description}}<div style="font-size: 16px; line-height: 1.5; color: #555; margin-top: 16px;">{{description}}</div>{{/description}}
{{^isLast}}<hr>{{/isLast}}
{{/jobs}}
<hr>
<p style="font-size: 16px; line-height: 1.5; color: #555;">Find more roles on our new <strong><a href="https://${getShortLinkDomain()}/NL_Jobs_Board" style="color: #4086c6;">jobs board</a></strong> - and if you want to post a role, get in touch.</p>
<hr>`;

    case 'footer':
      // Static content - no editable fields
      const nlConfig = getNewsletterConfig();
      const shortDomain = getShortLinkDomain();
      return `<p style="text-align: center; font-size: 16px; color: #555;">Interested in partnering with us? Get in touch: ${nlConfig.partnersEmail}</p>
<p style="text-align: center; font-size: 16px; color: #555;">Thanks for reading. See you in <a href="https://${shortDomain}/NL_Slack_Invite" style="color: #4086c6;">Slack</a>, <a href="https://${shortDomain}/NL_YouTube_Channel" style="color: #4086c6;">YouTube</a>, and <a href="https://${shortDomain}/NL_Gradual_Content" style="color: #4086c6;">podcast</a> land. Oh yeah, and we are also on <a href="https://${shortDomain}/NL_X_Homepage" style="color: #4086c6;">X</a> and <a href="https://${shortDomain}/NL_LinkedIn" style="color: #4086c6;">LinkedIn</a>.</p>`;

    default:
      // Generic fallback - just render content as paragraph
      return `<p style="color: #4086c6; font-size: 12px; text-transform: uppercase; margin-bottom: 8px;"><strong>${name.toUpperCase()}</strong></p>
{{#title}}<h2 style="font-size: 24px; font-weight: bold; color: #333; margin: 0 0 16px 0;">{{title}}</h2>{{/title}}
{{#body}}<div style="font-size: 16px; line-height: 1.5; color: #555;">{{body}}</div>{{/body}}
<hr>`;
  }
}

/**
 * Generate a rich text template for a brick
 */
function generateRichTextBrickTemplate(brickTemplate: BrickTemplate): string {
  const { brick_type } = brickTemplate;

  switch (brick_type) {
    case 'podcast':
      return `<h3 style="font-size: 20px; font-weight: bold; color: #333; margin: 0 0 12px 0;">{{title}}</h3>
{{#description}}<div style="font-size: 16px; line-height: 1.5; color: #555;">{{description}}</div>{{/description}}
<p style="font-size: 16px; margin-top: 12px;"><strong>
{{#video_link}}<a href="{{video_link}}" style="color: #4086c6;">Video</a>{{/video_link}}
{{#spotify_link}} || <a href="{{spotify_link}}" style="color: #4086c6;">Spotify</a>{{/spotify_link}}
{{#apple_link}} || <a href="{{apple_link}}" style="color: #4086c6;">Apple</a>{{/apple_link}}
</strong></p>
<hr style="border: none; border-top: 1px solid #bbb; margin: 16px 0;">`;

    case 'blog_post':
      return `<h3 style="font-size: 20px; font-weight: bold; color: #333; margin: 0 0 12px 0;">{{title}}</h3>
{{#description}}<div style="font-size: 16px; line-height: 1.5; color: #555;">{{description}}</div>{{/description}}
<p style="font-size: 16px; margin-top: 12px;"><strong><a href="{{blog_link}}" style="color: #4086c6;">{{link_text}}</a></strong></p>
<hr style="border: none; border-top: 1px solid #bbb; margin: 16px 0;">`;

    case 'reading_group':
      return `<h3 style="font-size: 20px; font-weight: bold; color: #333; margin: 0 0 12px 0;">{{title}}</h3>
{{#description}}<div style="font-size: 16px; line-height: 1.5; color: #555;">{{description}}</div>{{/description}}
<p style="font-size: 16px; margin-top: 12px;"><strong><a href="{{watch_link}}" style="color: #4086c6;">{{link_text}}</a></strong></p>
<hr style="border: none; border-top: 1px solid #bbb; margin: 16px 0;">`;

    default:
      return `<h3 style="font-size: 20px; font-weight: bold; color: #333; margin: 0 0 12px 0;">{{title}}</h3>
{{#description}}<div style="font-size: 16px; line-height: 1.5; color: #555;">{{description}}</div>{{/description}}`;
  }
}

/**
 * Get spacer HTML between blocks
 * Uses a simple empty table row for minimal vertical spacing
 */
function getBlockSpacer(format: OutputFormat): string {
  if (format === 'customerio') {
    // Simple spacer - just 10px of vertical space without any content
    return `<table class="row row-spacer" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace:0;mso-table-rspace:0">
<tbody><tr><td style="height:10px;font-size:1px;line-height:1px">&nbsp;</td></tr></tbody></table>`;
  }

  // For rich text formats, just use blank line
  return '\n';
}

/**
 * Wrap rich text output with minimal styling
 * Format param reserved for future platform-specific styling
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function wrapRichTextOutput(content: string, format: OutputFormat): string {
  const style = `
    <style>
      body { font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif; color: #555; line-height: 1.5; max-width: 650px; margin: 0 auto; padding: 20px; }
      h2 { font-size: 24px; font-weight: bold; margin: 0 0 16px 0; color: #333; }
      h3 { font-size: 20px; font-weight: bold; margin: 16px 0 12px 0; color: #333; }
      p { margin: 0 0 16px 0; font-size: 16px; }
      ul { margin: 0 0 8px 0; padding-left: 20px; list-style-type: disc; }
      li { margin: 0; padding-left: 0; }
      a { color: #4086c6; text-decoration: underline; }
      hr { border: none; border-top: 1px solid #4086c6; margin: 24px 0; }
      img { max-width: 100%; height: auto; }
    </style>
  `.trim();

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${style}
</head>
<body>
${content}
</body>
</html>`;
}

/**
 * Generate all output formats for an edition
 */
export function generateAllFormats(edition: NewsletterEdition): {
  customerio: string;
  substack: string;
  beehiiv: string;
} {
  return {
    customerio: generateNewsletterHtml(edition, 'customerio'),
    substack: generateNewsletterHtml(edition, 'substack'),
    beehiiv: generateNewsletterHtml(edition, 'beehiiv'),
  };
}

/**
 * Format date for display in newsletter
 */
export function formatNewsletterDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
