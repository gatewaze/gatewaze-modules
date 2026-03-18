/**
 * Newsletter Link Generator
 *
 * Extracts links from newsletter edition blocks/bricks and generates
 * short.io paths following the NL_ naming convention.
 *
 * Naming Convention: NL_[ContentType][Number]_[Platform]_[Date]_[Channel]
 *
 * Examples:
 * - NL_HT1_Jan08 - Hot Take poll option 1
 * - NL_Pod1_S_Jan08 - Podcast Spotify link
 * - NL_Gem1_Jan08_Sub - Hidden gem #1 for Substack
 */

import { getShortLinkDomain } from '@/config/brands';
import type { NewsletterEdition, EditionBlock, EditionBrick } from './htmlGenerator';

export type DistributionChannel = 'customerio' | 'substack' | 'beehiiv';

export interface ExtractedLink {
  blockId: string;
  brickId?: string;
  blockType: string;
  brickType?: string;
  linkType: string; // e.g., 'poll_option_1', 'cta', 'spotify', 'gem'
  linkIndex: number; // For multiple links of same type
  originalUrl: string;
  fieldPath: string; // Path to the field in content, e.g., 'poll_option_1_link'
  sectionTitle?: string; // For generic_section bricks, used to generate shortcode
}

export interface GeneratedLink extends ExtractedLink {
  shortPath: string; // e.g., 'NL_HT1_Jan08'
  distributionChannel: DistributionChannel;
}

/**
 * Map of block types to their content type shortcodes
 */
const BLOCK_TYPE_SHORTCODES: Record<string, string> = {
  hot_take: 'HT',
  last_weeks_take: 'LWT',
  sponsored_ad: 'Ad',
  hidden_gems: 'Gem',
  job_of_week: 'Job',
  ml_confessions: 'MLC',
  agent_infrastructure: 'AI',
  intro_paragraph: 'Intro',
};

/**
 * Map of brick types to their content type shortcodes
 */
const BRICK_TYPE_SHORTCODES: Record<string, string> = {
  podcast: 'Pod',
  blog_post: 'Blog',
  reading_group: 'RG',
  generic_section: 'GS', // Fallback, actual shortcode derived from section_title
};

/**
 * Map of link types to platform shortcodes (for bricks with multiple links)
 */
const PLATFORM_SHORTCODES: Record<string, string> = {
  spotify: 'S',
  apple: 'A',
  video: 'G', // Gradual/YouTube
  watch: 'G',
};

/**
 * Map of link types for ad blocks
 */
const AD_LINK_SHORTCODES: Record<string, string> = {
  cta: 'CTA',
  image: 'Image',
};

/**
 * Rich text fields that may contain links
 * Maps block_type -> array of field names containing rich text HTML
 */
const RICH_TEXT_FIELDS: Record<string, string[]> = {
  hot_take: ['body'],
  last_weeks_take: ['body'],
  sponsored_ad: ['body'],
  ml_confessions: ['story'],
  agent_infrastructure: ['body'],
  intro_paragraph: ['text'],
};

/**
 * Rich text fields in bricks
 */
const BRICK_RICH_TEXT_FIELDS: Record<string, string[]> = {
  podcast: ['description'],
  blog_post: ['description'],
  reading_group: ['description'],
  generic_section: ['description'],
};

/**
 * Generate a shortcode from a section title
 * Examples:
 * - "READING GROUP" → "RG"
 * - "AI NEWS" → "AIN"
 * - "Meetups" → "Meet"
 */
function generateShortcodeFromTitle(title: string): string {
  if (!title) return 'GS';

  // Clean and normalize the title
  const cleaned = title.trim().toUpperCase();

  // If it's multiple words, use initials
  const words = cleaned.split(/\s+/).filter(w => w.length > 0);
  if (words.length > 1) {
    // Take first letter of each word (up to 4 letters)
    return words.slice(0, 4).map(w => w[0]).join('');
  }

  // Single word: use first 4 characters
  return cleaned.slice(0, 4);
}

/**
 * Extract links from HTML content (rich text fields)
 * Returns array of { url, index } objects
 */
function extractLinksFromHtml(html: string): Array<{ url: string; index: number }> {
  const links: Array<{ url: string; index: number }> = [];

  if (!html || typeof html !== 'string') return links;

  // Match anchor tags with href attributes
  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match;
  let index = 1;

  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1];
    // Only include http/https links, skip mailto:, tel:, #, etc.
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      // Skip links that are already short links
      const shortDomain = getShortLinkDomain();
      if (!shortDomain || !url.includes(shortDomain)) {
        links.push({ url, index });
        index++;
      }
    }
  }

  return links;
}

/**
 * Format edition date for short link path
 * Converts '2026-01-08' to 'Jan08'
 */
export function formatDateForPath(dateString: string): string {
  const date = new Date(dateString);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()];
  const day = date.getDate().toString().padStart(2, '0');
  return `${month}${day}`;
}

/**
 * Get distribution channel suffix for short path
 */
function getChannelSuffix(channel: DistributionChannel): string {
  switch (channel) {
    case 'substack':
      return '_Sub';
    case 'beehiiv':
      return '_BH';
    default:
      return ''; // Customer.io is the default, no suffix
  }
}

/**
 * Extract links from a single block's content
 */
function extractBlockLinks(block: EditionBlock, blockIndex: number): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const { block_template, content, id: blockId } = block;
  const blockType = block_template.block_type;

  // Skip blocks that don't have tracked links
  if (!BLOCK_TYPE_SHORTCODES[blockType]) {
    return links;
  }

  switch (blockType) {
    case 'hot_take':
      // Poll option links
      if (content.poll_option_1_link) {
        links.push({
          blockId,
          blockType,
          linkType: 'poll_option_1',
          linkIndex: 1,
          originalUrl: content.poll_option_1_link as string,
          fieldPath: 'poll_option_1_link',
        });
      }
      if (content.poll_option_2_link) {
        links.push({
          blockId,
          blockType,
          linkType: 'poll_option_2',
          linkIndex: 2,
          originalUrl: content.poll_option_2_link as string,
          fieldPath: 'poll_option_2_link',
        });
      }
      break;

    case 'sponsored_ad':
      // Image and CTA links
      if (content.image_link) {
        links.push({
          blockId,
          blockType,
          linkType: 'image',
          linkIndex: 1,
          originalUrl: content.image_link as string,
          fieldPath: 'image_link',
        });
      }
      if (content.cta_link) {
        links.push({
          blockId,
          blockType,
          linkType: 'cta',
          linkIndex: 1,
          originalUrl: content.cta_link as string,
          fieldPath: 'cta_link',
        });
      }
      break;

    case 'hidden_gems':
      // Array of gems with links
      const gems = content.gems as Array<{ link_url?: string; link_text?: string; description?: string }> | undefined;
      if (gems && Array.isArray(gems)) {
        gems.forEach((gem, index) => {
          if (gem.link_url) {
            links.push({
              blockId,
              blockType,
              linkType: 'gem',
              linkIndex: index + 1,
              originalUrl: gem.link_url,
              fieldPath: `gems.${index}.link_url`,
            });
          }
        });
      }
      break;

    case 'job_of_week':
      // Array of jobs with apply links
      const jobs = content.jobs as Array<{ apply_link?: string; job_title?: string }> | undefined;
      if (jobs && Array.isArray(jobs)) {
        jobs.forEach((job, index) => {
          if (job.apply_link) {
            links.push({
              blockId,
              blockType,
              linkType: 'apply',
              linkIndex: index + 1,
              originalUrl: job.apply_link,
              fieldPath: `jobs.${index}.apply_link`,
            });
          }
        });
      }
      break;

    case 'agent_infrastructure':
      // Useful links array
      const usefulLinks = content.useful_links as Array<{ url?: string; title?: string }> | undefined;
      if (usefulLinks && Array.isArray(usefulLinks)) {
        usefulLinks.forEach((link, index) => {
          if (link.url) {
            links.push({
              blockId,
              blockType,
              linkType: 'useful_link',
              linkIndex: index + 1,
              originalUrl: link.url,
              fieldPath: `useful_links.${index}.url`,
            });
          }
        });
      }
      break;

    case 'ml_confessions':
      if (content.confess_link) {
        links.push({
          blockId,
          blockType,
          linkType: 'confess',
          linkIndex: 1,
          originalUrl: content.confess_link as string,
          fieldPath: 'confess_link',
        });
      }
      break;
  }

  // Extract links from rich text fields (body, story, etc.)
  const richTextFields = RICH_TEXT_FIELDS[blockType] || [];
  let richTextLinkIndex = 1;

  for (const fieldName of richTextFields) {
    const htmlContent = content[fieldName];
    if (htmlContent && typeof htmlContent === 'string') {
      const htmlLinks = extractLinksFromHtml(htmlContent);
      for (const htmlLink of htmlLinks) {
        links.push({
          blockId,
          blockType,
          linkType: `richtext_${fieldName}`,
          linkIndex: richTextLinkIndex,
          originalUrl: htmlLink.url,
          fieldPath: `${fieldName}:html:${htmlLink.index}`,
        });
        richTextLinkIndex++;
      }
    }
  }

  return links;
}

/**
 * Extract links from a single brick's content
 */
function extractBrickLinks(
  brick: EditionBrick,
  blockId: string,
  brickIndex: number
): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const { brick_template, content, id: brickId } = brick;
  const brickType = brick_template.brick_type;

  // Skip bricks that don't have tracked links
  if (!BRICK_TYPE_SHORTCODES[brickType]) {
    return links;
  }

  switch (brickType) {
    case 'podcast':
      // Multiple platform links
      if (content.video_link) {
        links.push({
          blockId,
          brickId,
          blockType: 'mlops_community',
          brickType,
          linkType: 'video',
          linkIndex: brickIndex,
          originalUrl: content.video_link as string,
          fieldPath: 'video_link',
        });
      }
      if (content.spotify_link) {
        links.push({
          blockId,
          brickId,
          blockType: 'mlops_community',
          brickType,
          linkType: 'spotify',
          linkIndex: brickIndex,
          originalUrl: content.spotify_link as string,
          fieldPath: 'spotify_link',
        });
      }
      if (content.apple_link) {
        links.push({
          blockId,
          brickId,
          blockType: 'mlops_community',
          brickType,
          linkType: 'apple',
          linkIndex: brickIndex,
          originalUrl: content.apple_link as string,
          fieldPath: 'apple_link',
        });
      }
      break;

    case 'blog_post':
      if (content.blog_link) {
        links.push({
          blockId,
          brickId,
          blockType: 'mlops_community',
          brickType,
          linkType: 'blog',
          linkIndex: brickIndex,
          originalUrl: content.blog_link as string,
          fieldPath: 'blog_link',
        });
      }
      break;

    case 'reading_group':
      if (content.watch_link) {
        links.push({
          blockId,
          brickId,
          blockType: 'mlops_community',
          brickType,
          linkType: 'watch',
          linkIndex: brickIndex,
          originalUrl: content.watch_link as string,
          fieldPath: 'watch_link',
        });
      }
      break;

    case 'generic_section':
      if (content.link) {
        links.push({
          blockId,
          brickId,
          blockType: 'mlops_community',
          brickType,
          linkType: 'link',
          linkIndex: brickIndex,
          originalUrl: content.link as string,
          fieldPath: 'link',
          sectionTitle: content.section_title as string,
        });
      }
      break;
  }

  // Extract links from rich text fields in bricks (description, etc.)
  const richTextFields = BRICK_RICH_TEXT_FIELDS[brickType] || [];
  let richTextLinkIndex = 1;

  for (const fieldName of richTextFields) {
    const htmlContent = content[fieldName];
    if (htmlContent && typeof htmlContent === 'string') {
      const htmlLinks = extractLinksFromHtml(htmlContent);
      for (const htmlLink of htmlLinks) {
        links.push({
          blockId,
          brickId,
          blockType: 'mlops_community',
          brickType,
          linkType: `richtext_${fieldName}`,
          linkIndex: richTextLinkIndex,
          originalUrl: htmlLink.url,
          fieldPath: `${fieldName}:html:${htmlLink.index}`,
        });
        richTextLinkIndex++;
      }
    }
  }

  return links;
}

/**
 * Extract all trackable links from a newsletter edition
 */
export function extractEditionLinks(edition: NewsletterEdition): ExtractedLink[] {
  const allLinks: ExtractedLink[] = [];

  // Track counts for each content type to assign proper indices
  const typeCounts: Record<string, number> = {};

  // Sort blocks by sort_order
  const sortedBlocks = [...edition.blocks].sort((a, b) => a.sort_order - b.sort_order);

  sortedBlocks.forEach((block, blockIndex) => {
    // Extract block-level links
    const blockLinks = extractBlockLinks(block, blockIndex);
    allLinks.push(...blockLinks);

    // Extract brick-level links
    if (block.bricks && block.bricks.length > 0) {
      const sortedBricks = [...block.bricks].sort((a, b) => a.sort_order - b.sort_order);

      sortedBricks.forEach((brick, brickIndex) => {
        const brickType = brick.brick_template.brick_type;

        // Track brick index per type
        if (!typeCounts[brickType]) {
          typeCounts[brickType] = 0;
        }
        typeCounts[brickType]++;

        const brickLinks = extractBrickLinks(brick, block.id, typeCounts[brickType]);
        allLinks.push(...brickLinks);
      });
    }
  });

  return allLinks;
}

/**
 * Generate short path for a single link
 */
export function generateShortPath(
  link: ExtractedLink,
  editionDate: string,
  channel: DistributionChannel
): string {
  const datePart = formatDateForPath(editionDate);
  const channelSuffix = getChannelSuffix(channel);

  // Handle brick-level links (podcasts, blogs, reading groups, generic sections)
  if (link.brickType) {
    let brickShortcode = BRICK_TYPE_SHORTCODES[link.brickType];

    // For generic_section, derive shortcode from section_title
    if (link.brickType === 'generic_section' && link.sectionTitle) {
      brickShortcode = generateShortcodeFromTitle(link.sectionTitle);
    }

    const platformShortcode = PLATFORM_SHORTCODES[link.linkType];

    if (platformShortcode) {
      // e.g., NL_Pod1_S_Jan08 (Podcast #1, Spotify)
      return `NL_${brickShortcode}${link.linkIndex}_${platformShortcode}_${datePart}${channelSuffix}`;
    } else {
      // e.g., NL_Blog1_Jan08 (Blog #1)
      return `NL_${brickShortcode}${link.linkIndex}_${datePart}${channelSuffix}`;
    }
  }

  // Handle block-level links
  const blockShortcode = BLOCK_TYPE_SHORTCODES[link.blockType];

  // Handle rich text links first (links embedded in body/story/description fields)
  // These need a different path format to distinguish from structured links
  if (link.linkType.startsWith('richtext_')) {
    return `NL_${blockShortcode}RT${link.linkIndex}_${datePart}${channelSuffix}`;
  }

  // Special handling for different block types
  switch (link.blockType) {
    case 'hot_take':
      // e.g., NL_HT1_Jan08 for poll option 1, NL_HT2_Jan08 for option 2
      return `NL_${blockShortcode}${link.linkIndex}_${datePart}${channelSuffix}`;

    case 'sponsored_ad':
      // e.g., NL_Ad1_CTA_Jan08 or NL_Ad1_Image_Jan08
      const adLinkShortcode = AD_LINK_SHORTCODES[link.linkType];
      return `NL_${blockShortcode}${link.linkIndex}_${adLinkShortcode}_${datePart}${channelSuffix}`;

    case 'hidden_gems':
      // e.g., NL_Gem1_Jan08, NL_Gem2_Jan08
      return `NL_${blockShortcode}${link.linkIndex}_${datePart}${channelSuffix}`;

    case 'job_of_week':
      // e.g., NL_Job1_Jan08
      return `NL_${blockShortcode}${link.linkIndex}_${datePart}${channelSuffix}`;

    case 'agent_infrastructure':
      // e.g., NL_AI1_Jan08 for useful link #1
      return `NL_${blockShortcode}${link.linkIndex}_${datePart}${channelSuffix}`;

    case 'intro_paragraph':
      // e.g., NL_Intro1_Jan08 for links in intro text
      return `NL_${blockShortcode}${link.linkIndex}_${datePart}${channelSuffix}`;

    case 'ml_confessions':
      // e.g., NL_MLC_Jan08 for confession form link
      return `NL_${blockShortcode}_${datePart}${channelSuffix}`;

    default:
      // Generic fallback for any other block types
      return `NL_${blockShortcode || 'Unknown'}${link.linkIndex}_${datePart}${channelSuffix}`;
  }
}

/**
 * Generate all short links for an edition across all distribution channels
 */
export function generateEditionLinks(
  edition: NewsletterEdition,
  channels: DistributionChannel[] = ['customerio', 'substack', 'beehiiv']
): GeneratedLink[] {
  const extractedLinks = extractEditionLinks(edition);
  const generatedLinks: GeneratedLink[] = [];

  for (const channel of channels) {
    for (const link of extractedLinks) {
      const shortPath = generateShortPath(link, edition.edition_date, channel);

      generatedLinks.push({
        ...link,
        shortPath,
        distributionChannel: channel,
      });
    }
  }

  return generatedLinks;
}

/**
 * Get the full short URL from a path
 */
export function getFullShortUrl(shortPath: string): string {
  const domain = getShortLinkDomain();
  return `https://${domain}/${shortPath}`;
}
