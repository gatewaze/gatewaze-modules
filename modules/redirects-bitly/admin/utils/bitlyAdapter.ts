/**
 * Bitly Redirect Adapter
 *
 * Implements the IRedirectAdapter interface for Bitly link shortening.
 * Provides bulk link creation, deletion, and click analytics.
 */

import type {
  IRedirectAdapter,
  RedirectLink,
  RedirectResult,
  RedirectStats,
} from '../../newsletters/types/redirect-adapter';

const BITLY_API_BASE = 'https://api-ssl.bitly.com/v4';
const RATE_LIMIT_DELAY_MS = 100;

interface BitlyConfig {
  accessToken: string;
  groupGuid?: string;
  domain?: string;
}

/**
 * Create a single Bitly link
 */
async function createBitlyLink(
  config: BitlyConfig,
  link: RedirectLink
): Promise<RedirectResult> {
  try {
    const domain = config.domain || 'bit.ly';
    const body: Record<string, unknown> = {
      long_url: link.originalUrl,
      domain,
      title: link.title || undefined,
    };

    if (config.groupGuid) {
      body.group_guid = config.groupGuid;
    }

    // Bitly doesn't support custom paths on free plans, but we include it as a tag
    if (link.path) {
      body.tags = [link.path];
    }

    const response = await fetch(`${BITLY_API_BASE}/bitlinks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const data = await response.json();
      return {
        path: link.path,
        originalUrl: link.originalUrl,
        shortUrl: data.link,
        providerId: data.id,
        success: true,
        isNew: true,
      };
    }

    // 409 means the link already exists
    if (response.status === 409) {
      const errorData = await response.json();
      // Bitly returns the existing link in the error response
      if (errorData.description?.includes('ALREADY_A_BITLY_LINK')) {
        return {
          path: link.path,
          originalUrl: link.originalUrl,
          shortUrl: link.originalUrl,
          providerId: '',
          success: true,
          isNew: false,
        };
      }
    }

    const errorText = await response.text();
    return {
      path: link.path,
      originalUrl: link.originalUrl,
      shortUrl: '',
      providerId: '',
      success: false,
      isNew: false,
      error: `Bitly API error ${response.status}: ${errorText}`,
    };
  } catch (error) {
    return {
      path: link.path,
      originalUrl: link.originalUrl,
      shortUrl: '',
      providerId: '',
      success: false,
      isNew: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export function createBitlyAdapter(config: BitlyConfig): IRedirectAdapter {
  return {
    meta: {
      id: 'bitly',
      label: 'Bitly',
      description: 'Bitly link shortening with click analytics',
      icon: 'LinkIcon',
    },

    async createBulk(links: RedirectLink[]): Promise<RedirectResult[]> {
      const results: RedirectResult[] = [];

      for (const link of links) {
        const result = await createBitlyLink(config, link);
        results.push(result);
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
      }

      return results;
    },

    async delete(providerId: string): Promise<void> {
      const response = await fetch(`${BITLY_API_BASE}/bitlinks/${providerId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok && response.status !== 404) {
        const errorText = await response.text();
        throw new Error(`Failed to delete Bitly link: ${response.status} - ${errorText}`);
      }
    },

    async getStats(providerId: string): Promise<RedirectStats> {
      const response = await fetch(
        `${BITLY_API_BASE}/bitlinks/${providerId}/clicks/summary`,
        {
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to get Bitly stats: ${response.status}`);
      }

      const data = await response.json();

      return {
        totalClicks: data.total_clicks || 0,
        uniqueClicks: data.total_clicks || 0, // Bitly doesn't separate unique in summary
        humanClicks: data.total_clicks || 0,
        lastClickAt: null,
      };
    },

    async validateConfig(): Promise<{ valid: boolean; error?: string }> {
      try {
        const response = await fetch(`${BITLY_API_BASE}/user`, {
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          return { valid: false, error: `Bitly API returned ${response.status}` };
        }

        return { valid: true };
      } catch (error) {
        return {
          valid: false,
          error: error instanceof Error ? error.message : 'Failed to connect to Bitly',
        };
      }
    },
  };
}
