/**
 * Newsletter Link Service
 *
 * Handles creating and managing short.io links for newsletter editions.
 * Calls the /api/redirects/create-bulk endpoint to generate links.
 */

import { getApiBaseUrl, getShortLinkDomain } from '@/config/brands';
import { supabase } from '@/lib/supabase';
import type { NewsletterEdition } from './types';
import {
  extractEditionLinks,
  generateShortPath,
  getFullShortUrl,
  type DistributionChannel,
  type ExtractedLink,
  type GeneratedLink,
} from './linkGenerator';

export interface LinkGenerationResult {
  success: boolean;
  created: number;
  updated: number;
  errors: number;
  links: GeneratedLink[];
  errorMessages: string[];
}

interface BulkCreateResponse {
  success: boolean;
  created: number;
  updated: number;
  errors: number;
  results: Array<{
    path: string;
    success?: boolean;
    isNew?: boolean;
    shortUrl?: string;
    shortioId?: string;
    redirectId?: string;
    error?: string;
  }>;
}

/**
 * Generate short links for all trackable URLs in a newsletter edition
 * Creates links for all distribution channels (HTML, Substack, Beehiiv)
 */
export async function generateEditionShortLinks(
  edition: NewsletterEdition,
  channels: DistributionChannel[] = ['html'],
  redirectProvider?: string | null
): Promise<LinkGenerationResult> {
  const result: LinkGenerationResult = {
    success: true,
    created: 0,
    updated: 0,
    errors: 0,
    links: [],
    errorMessages: [],
  };

  try {
    // If no redirect provider configured, skip link generation (use full URLs)
    if (redirectProvider === null || redirectProvider === undefined) {
      console.log('No redirect provider configured, using full URLs');
      return result;
    }

    // Extract all links from the edition
    const extractedLinks = extractEditionLinks(edition);

    if (extractedLinks.length === 0) {
      console.log('No trackable links found in edition');
      return result;
    }

    console.log(`Found ${extractedLinks.length} trackable links in edition`);

    // Generate short paths for each link and channel
    const linksToCreate: Array<{
      path: string;
      originalUrl: string;
      title: string;
      extractedLink: ExtractedLink;
      channel: DistributionChannel;
    }> = [];

    for (const channel of channels) {
      for (const link of extractedLinks) {
        const shortPath = generateShortPath(link, edition.edition_date, channel);
        linksToCreate.push({
          path: shortPath,
          originalUrl: link.originalUrl,
          title: `${shortPath} - ${link.linkType}`,
          extractedLink: link,
          channel,
        });
      }
    }

    console.log(`Generating ${linksToCreate.length} short links...`);

    // Get auth token
    const { data: session } = await supabase.auth.getSession();
    if (!session?.session?.access_token) {
      throw new Error('Not authenticated');
    }

    // Call the bulk create API
    const apiBaseUrl = getApiBaseUrl();
    const response = await fetch(`${apiBaseUrl}/api/redirects/create-bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.session.access_token}`,
      },
      body: JSON.stringify({
        domain: getShortLinkDomain(),
        links: linksToCreate.map(l => ({
          path: l.path,
          originalUrl: l.originalUrl,
          title: l.title,
        })),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create short links: ${response.status} - ${errorText}`);
    }

    const bulkResult: BulkCreateResponse = await response.json();

    result.created = bulkResult.created;
    result.updated = bulkResult.updated;
    result.errors = bulkResult.errors;

    // Map results back to GeneratedLink format
    for (let i = 0; i < linksToCreate.length; i++) {
      const linkToCreate = linksToCreate[i];
      const apiResult = bulkResult.results[i];

      if (apiResult?.success) {
        result.links.push({
          ...linkToCreate.extractedLink,
          shortPath: linkToCreate.path,
          distributionChannel: linkToCreate.channel,
        });
      } else if (apiResult?.error) {
        result.errorMessages.push(`${linkToCreate.path}: ${apiResult.error}`);
      }
    }

    // Save link mappings to newsletter_edition_links table
    if (result.links.length > 0) {
      await saveEditionLinks(edition.id, result.links, bulkResult.results);
    }

    result.success = result.errors === 0;
    console.log(`Link generation complete: ${result.created} created, ${result.updated} updated, ${result.errors} errors`);

    return result;

  } catch (error) {
    console.error('Error generating edition short links:', error);
    result.success = false;
    result.errorMessages.push(error instanceof Error ? error.message : 'Unknown error');
    return result;
  }
}

/**
 * Save generated links to the newsletter_edition_links table
 */
async function saveEditionLinks(
  editionId: string,
  links: GeneratedLink[],
  apiResults: BulkCreateResponse['results']
): Promise<void> {
  try {
    // Create a map of path -> result for quick lookup
    const resultMap = new Map(apiResults.map(r => [r.path, r]));

    const linksToInsert = links.map(link => {
      const apiResult = resultMap.get(link.shortPath);

      return {
        edition_id: editionId,
        // Don't include block_id/brick_id - they may reference client-side UUIDs
        // that don't exist in the DB yet (unsaved new blocks), causing FK violations.
        // URL replacement only uses originalUrl matching, not block/brick IDs.
        block_id: null,
        brick_id: null,
        link_type: link.linkType,
        link_index: link.linkIndex,
        original_url: link.originalUrl,
        short_path: link.shortPath,
        short_url: apiResult?.shortUrl || getFullShortUrl(link.shortPath),
        distribution_channel: link.distributionChannel,
        shortio_id: apiResult?.shortioId || null,
        redirect_id: apiResult?.redirectId || null,
        status: apiResult?.success ? 'created' : 'error',
        error_message: apiResult?.error || null,
      };
    });

    // Upsert to handle re-saves
    const { error } = await supabase
      .from('newsletters_edition_links')
      .upsert(linksToInsert, {
        onConflict: 'edition_id,short_path,distribution_channel',
        ignoreDuplicates: false,
      });

    if (error) {
      console.error('Error saving edition links:', error);
      throw error;
    }

    console.log(`Saved ${linksToInsert.length} link mappings to database`);

  } catch (error) {
    console.error('Error in saveEditionLinks:', error);
    // Don't throw - link saving failure shouldn't block generation
    // The in-memory links are passed directly to HtmlPreview as a fallback
  }
}

/**
 * Get all generated links for an edition
 */
export async function getEditionLinks(editionId: string): Promise<GeneratedLink[]> {
  try {
    const { data, error } = await supabase
      .from('newsletters_edition_links')
      .select('*')
      .eq('edition_id', editionId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Convert database records to GeneratedLink format
    return (data || []).map(record => ({
      blockId: record.block_id,
      brickId: record.brick_id,
      blockType: '', // Not stored in DB
      brickType: undefined,
      linkType: record.link_type,
      linkIndex: record.link_index,
      originalUrl: record.original_url,
      fieldPath: '', // Not stored in DB
      shortPath: record.short_path,
      distributionChannel: record.distribution_channel as DistributionChannel,
    }));

  } catch (error) {
    console.error('Error fetching edition links:', error);
    return [];
  }
}

/**
 * Replace original URLs in edition content with short URLs
 * This modifies the edition in place and returns it
 */
export function replaceUrlsWithShortLinks(
  edition: NewsletterEdition,
  links: GeneratedLink[],
  channel: DistributionChannel
): NewsletterEdition {
  // Create a map of blockId+fieldPath -> shortUrl for this channel
  const linkMap = new Map<string, string>();

  for (const link of links) {
    if (link.distributionChannel === channel) {
      const key = link.brickId
        ? `${link.blockId}:${link.brickId}:${link.fieldPath}`
        : `${link.blockId}:${link.fieldPath}`;
      linkMap.set(key, getFullShortUrl(link.shortPath));
    }
  }

  // Deep clone the edition to avoid mutations
  const updatedEdition = JSON.parse(JSON.stringify(edition)) as NewsletterEdition;

  // Replace URLs in blocks
  for (const block of updatedEdition.blocks) {
    replaceUrlsInContent(block.id, undefined, block.content, linkMap);

    // Replace URLs in bricks
    if (block.bricks) {
      for (const brick of block.bricks) {
        replaceUrlsInContent(block.id, brick.id, brick.content, linkMap);
      }
    }
  }

  return updatedEdition;
}

/**
 * Helper to replace URLs in a content object
 */
function replaceUrlsInContent(
  blockId: string,
  brickId: string | undefined,
  content: Record<string, unknown>,
  linkMap: Map<string, string>
): void {
  for (const [key, value] of Object.entries(content)) {
    if (typeof value === 'string' && value.startsWith('http')) {
      const mapKey = brickId
        ? `${blockId}:${brickId}:${key}`
        : `${blockId}:${key}`;

      const shortUrl = linkMap.get(mapKey);
      if (shortUrl) {
        content[key] = shortUrl;
      }
    } else if (Array.isArray(value)) {
      // Handle arrays (like gems[])
      value.forEach((item, index) => {
        if (typeof item === 'object' && item !== null) {
          for (const [itemKey, itemValue] of Object.entries(item)) {
            if (typeof itemValue === 'string' && itemValue.startsWith('http')) {
              const mapKey = brickId
                ? `${blockId}:${brickId}:${key}.${index}.${itemKey}`
                : `${blockId}:${key}.${index}.${itemKey}`;

              const shortUrl = linkMap.get(mapKey);
              if (shortUrl) {
                (item as Record<string, unknown>)[itemKey] = shortUrl;
              }
            }
          }
        }
      });
    }
  }
}
