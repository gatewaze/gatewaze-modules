/**
 * Substack Rich Text Output Adapter
 *
 * Generates simplified semantic HTML suitable for pasting into Substack's
 * rich text editor. Excludes header, footer, and promotional blocks that
 * Substack provides natively.
 */

import { renderTemplate } from '@/utils/templateParser';
// Cross-module bare-specifier imports are resolved by the admin's vite
// plugin via gatewaze-modules sources. The renderViaEditionEmail helper
// + hasReactEmailBlocks predicate live in the (open-source) newsletters
// module and are accessed via the same namespaced path the existing
// adapter contract uses.
import { renderViaEditionEmail, hasReactEmailBlocks } from '@gatewaze-modules/newsletters/admin/utils/renderViaEditionEmail';
import type {
  INewsletterOutputAdapter,
  OutputRenderContext,
  OutputRenderOptions,
  OutputBlock,
  OutputBrick,
} from '../../newsletters/types/output-adapter';

/**
 * Block types excluded from Substack output.
 * Substack provides its own header/footer and we skip promotional blocks.
 */
const EXCLUDED_BLOCK_TYPES = ['header', 'footer', 'how_we_can_help'];

/**
 * Wrap rendered content in minimal HTML with a style block
 */
function wrapRichTextOutput(content: string): string {
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
 * Generate a fallback rich text template for a block type
 */
function generateRichTextTemplate(blockType: string, blockName: string): string {
  switch (blockType) {
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

    case 'community':
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
      return `<p style="font-size: 17px; font-weight: bold; color: #000; margin-bottom: 16px;">{{header_title}}</p>
{{#jobs}}
<p style="font-size: 16px; line-height: 1.5; color: #555;"><strong><a href="{{apply_link}}" style="color: #4086c6;">{{job_title}}</a> // {{company}}{{#location}} ({{location}}){{/location}}</strong></p>
{{#description}}<div style="font-size: 16px; line-height: 1.5; color: #555; margin-top: 16px;">{{description}}</div>{{/description}}
{{^isLast}}<hr>{{/isLast}}
{{/jobs}}
<hr>`;

    default:
      return `<p style="color: #4086c6; font-size: 12px; text-transform: uppercase; margin-bottom: 8px;"><strong>${blockName.toUpperCase()}</strong></p>
{{#title}}<h2 style="font-size: 24px; font-weight: bold; color: #333; margin: 0 0 16px 0;">{{title}}</h2>{{/title}}
{{#body}}<div style="font-size: 16px; line-height: 1.5; color: #555;">{{body}}</div>{{/body}}
<hr>`;
  }
}

/**
 * Generate a fallback rich text template for a brick type
 */
function generateRichTextBrickTemplate(brickType: string): string {
  switch (brickType) {
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
 * Render a single block with its rich text template
 */
function renderBlock(block: OutputBlock): string {
  const template = block.template || generateRichTextTemplate(block.block_type, block.block_type);

  let blockContent: Record<string, unknown> = { ...block.content };

  if (block.has_bricks && block.bricks.length > 0) {
    const sortedBricks = [...block.bricks].sort((a, b) => a.sort_order - b.sort_order);
    const renderedBricks = sortedBricks
      .map((brick, index) => {
        let html = renderBrick(brick);
        if (index === sortedBricks.length - 1) {
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
 * Render a single brick with its rich text template
 */
function renderBrick(brick: OutputBrick): string {
  const template = brick.template || generateRichTextBrickTemplate(brick.brick_type);
  return renderTemplate(template, brick.content);
}

export const SubstackOutputAdapter: INewsletterOutputAdapter = {
  meta: {
    id: 'substack',
    label: 'Substack',
    description: 'Simplified semantic HTML for Substack rich text editor',
    icon: 'DocumentTextIcon',
    order: 2,
  },

  excludedBlockTypes: EXCLUDED_BLOCK_TYPES,

  templateVariantKey: 'rich_text_template',

  supportsBlockComments: false,

  async render(context: OutputRenderContext): Promise<string> {
    // Filter excluded block types BEFORE deciding the render path —
    // Substack-excluded blocks (header/footer/promo) drop out regardless
    // of render_kind.
    const filteredCtx: OutputRenderContext = {
      ...context,
      blocks: context.blocks.filter((b) => !EXCLUDED_BLOCK_TYPES.includes(b.block_type)),
    };

    // Per spec-builder-evaluation §3.6 (extended). When any block is
    // react-email, route through EditionEmail with format='substack'.
    // Each registry block then renders via its `formats.substack`
    // Component variant (or falls back to its base Component if the
    // block doesn't define a Substack variant). The resulting HTML
    // already lives inside an `<Html><Body>` shell; we strip that
    // boilerplate to keep Substack happy (it expects body-only HTML
    // for pasting into the rich-text editor) and run the existing
    // wrapRichTextOutput post-processor.
    if (hasReactEmailBlocks(filteredCtx)) {
      const fullHtml = await renderViaEditionEmail({ context: filteredCtx, format: 'substack' });
      const bodyHtml = extractBodyContent(fullHtml);
      return wrapRichTextOutput(bodyHtml);
    }

    const sortedBlocks = [...filteredCtx.blocks].sort((a, b) => a.sort_order - b.sort_order);
    const renderedBlocks = sortedBlocks.map(block => renderBlock(block));
    const blockContent = renderedBlocks.join('\n');

    return wrapRichTextOutput(blockContent);
  },
};

/**
 * Strip the `<html>...</html>` shell from EditionEmail's output, leaving
 * just the body's inner HTML. Substack and Beehiiv expect content-only
 * markup — an outer `<html>` wrapper confuses their import path.
 *
 * Cheap regex parser — robust enough because EditionEmail's output is
 * deterministic (we control its structure). Falls through to the original
 * string when the pattern doesn't match (defensive for future shape
 * changes).
 */
function extractBodyContent(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : html;
}
