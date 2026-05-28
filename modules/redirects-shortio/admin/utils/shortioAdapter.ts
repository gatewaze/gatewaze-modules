/**
 * Short.io Redirect Adapter
 *
 * Implements the IRedirectAdapter interface for Short.io link shortening.
 * Provides bulk link creation, deletion, and click analytics.
 */

import type {
  IRedirectAdapter,
  RedirectAdapterMeta,
  RedirectLink,
  RedirectResult,
  RedirectStats,
} from '../../newsletters/types/redirect-adapter';

const SHORTIO_API_BASE = 'https://api.short.io';
const RATE_LIMIT_DELAY_MS = 200;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 2000;

interface ShortioConfig {
  apiKey: string;
  domain: string;
}

/**
 * Fetch with exponential backoff retry for rate limits and server errors
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = MAX_RETRIES
): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const response = await fetch(url, options);
    if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
      if (attempt < retries) {
        const waitTime = RETRY_BASE_DELAY_MS * attempt;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
    }
    return response;
  }
  throw new Error('Max retries exceeded');
}

/**
 * Create a single Short.io link
 */
async function createShortioLink(
  config: ShortioConfig,
  link: RedirectLink
): Promise<RedirectResult> {
  try {
    const response = await fetchWithRetry(`${SHORTIO_API_BASE}/links`, {
      method: 'POST',
      headers: {
        Authorization: config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        domain: config.domain,
        originalURL: link.originalUrl,
        path: link.path,
        title: link.title || undefined,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      return {
        path: link.path,
        originalUrl: link.originalUrl,
        shortUrl: `https://${config.domain}/${data.path}`,
        providerId: data.id.toString(),
        success: true,
        isNew: true,
      };
    }

    // If 409 conflict, the link already exists — try to update it
    if (response.status === 409) {
      return await updateShortioLink(config, link);
    }

    const errorText = await response.text();
    return {
      path: link.path,
      originalUrl: link.originalUrl,
      shortUrl: '',
      providerId: '',
      success: false,
      isNew: false,
      error: `Short.io API error ${response.status}: ${errorText}`,
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

/**
 * Update an existing Short.io link by path
 */
async function updateShortioLink(
  config: ShortioConfig,
  link: RedirectLink
): Promise<RedirectResult> {
  try {
    // First, look up the existing link by path
    const lookupResponse = await fetchWithRetry(
      `${SHORTIO_API_BASE}/links/by-path?domain=${encodeURIComponent(config.domain)}&path=${encodeURIComponent(link.path)}`,
      {
        headers: {
          Authorization: config.apiKey,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!lookupResponse.ok) {
      return {
        path: link.path,
        originalUrl: link.originalUrl,
        shortUrl: `https://${config.domain}/${link.path}`,
        providerId: '',
        success: false,
        isNew: false,
        error: `Failed to look up existing link: ${lookupResponse.status}`,
      };
    }

    const existing = await lookupResponse.json();

    // Update the link
    const updateResponse = await fetchWithRetry(
      `${SHORTIO_API_BASE}/links/${existing.id}`,
      {
        method: 'POST',
        headers: {
          Authorization: config.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          originalURL: link.originalUrl,
          title: link.title || undefined,
        }),
      }
    );

    if (updateResponse.ok) {
      return {
        path: link.path,
        originalUrl: link.originalUrl,
        shortUrl: `https://${config.domain}/${link.path}`,
        providerId: existing.id.toString(),
        success: true,
        isNew: false,
      };
    }

    const errorText = await updateResponse.text();
    return {
      path: link.path,
      originalUrl: link.originalUrl,
      shortUrl: `https://${config.domain}/${link.path}`,
      providerId: existing.id.toString(),
      success: false,
      isNew: false,
      error: `Failed to update link: ${updateResponse.status} - ${errorText}`,
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

export function createShortioAdapter(config: ShortioConfig): IRedirectAdapter {
  return {
    meta: {
      id: 'shortio',
      label: 'Short.io',
      description: 'Short.io link shortening with click analytics',
      icon: 'LinkIcon',
    },

    async createBulk(links: RedirectLink[]): Promise<RedirectResult[]> {
      const results: RedirectResult[] = [];

      for (const link of links) {
        const result = await createShortioLink(config, link);
        results.push(result);
        // Rate limit between requests
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
      }

      return results;
    },

    async delete(providerId: string): Promise<void> {
      const response = await fetchWithRetry(
        `${SHORTIO_API_BASE}/links/${providerId}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: config.apiKey,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to delete Short.io link: ${response.status} - ${errorText}`);
      }
    },

    async getStats(providerId: string): Promise<RedirectStats> {
      const response = await fetchWithRetry(
        `${SHORTIO_API_BASE}/links/${providerId}/statistics`,
        {
          headers: {
            Authorization: config.apiKey,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to get Short.io stats: ${response.status}`);
      }

      const data = await response.json();

      return {
        totalClicks: data.totalClicks || 0,
        uniqueClicks: data.uniqueClicks || 0,
        humanClicks: data.humanClicks || 0,
        lastClickAt: data.lastClickAt || null,
      };
    },

    async validateConfig(): Promise<{ valid: boolean; error?: string }> {
      try {
        const response = await fetch(`${SHORTIO_API_BASE}/api/domains`, {
          headers: {
            Authorization: config.apiKey,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          return { valid: false, error: `Short.io API returned ${response.status}` };
        }

        const domains: Array<{ hostname: string }> = await response.json();
        const domainExists = domains.some(d => d.hostname === config.domain);

        if (!domainExists) {
          return {
            valid: false,
            error: `Domain '${config.domain}' not found in Short.io account. Available: ${domains.map(d => d.hostname).join(', ')}`,
          };
        }

        return { valid: true };
      } catch (error) {
        return {
          valid: false,
          error: error instanceof Error ? error.message : 'Failed to connect to Short.io',
        };
      }
    },
  };
}
