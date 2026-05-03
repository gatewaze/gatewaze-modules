/**
 * Redirect Adapter Interface
 *
 * Defines the contract that all link shortening/redirect modules must implement.
 * Adapters handle creating, deleting, and tracking short links via external
 * services (Short.io, Bitly, etc.) or custom implementations.
 */

export interface RedirectAdapterMeta {
  /** Unique adapter ID, e.g. 'shortio', 'bitly' */
  id: string;
  /** Display name for UI */
  label: string;
  /** Short description */
  description: string;
  /** Icon name for UI (Heroicons) */
  icon: string;
}

export interface RedirectLink {
  /** The original (long) URL to shorten */
  originalUrl: string;
  /** The desired short path (e.g., 'NL_HT1_Jan08') */
  shortPath: string;
  /** Optional domain override (defaults to adapter's configured domain) */
  domain?: string;
}

export interface RedirectResult {
  /** The original URL that was shortened */
  originalUrl: string;
  /** The full short URL (e.g., 'https://short.domain/NL_HT1_Jan08') */
  shortUrl: string;
  /** The short path portion */
  shortPath: string;
  /** The provider-specific link ID (e.g., Short.io link ID) */
  providerId: string;
  /** Whether creation succeeded */
  status: 'created' | 'updated' | 'error';
  /** Error message if status is 'error' */
  error?: string;
}

export interface RedirectStats {
  clicks: number;
  uniqueClicks?: number;
  humanClicks?: number;
  [key: string]: unknown;
}

export interface IRedirectAdapter {
  meta: RedirectAdapterMeta;

  /**
   * Create or update multiple short links in bulk.
   * Should handle rate limiting internally with retries.
   */
  createBulk(links: RedirectLink[]): Promise<RedirectResult[]>;

  /**
   * Delete a previously created short link by its provider-specific ID.
   */
  delete(providerId: string): Promise<void>;

  /**
   * Get analytics/stats for a short link.
   * Optional — not all adapters may support analytics.
   */
  getStats?(providerId: string): Promise<RedirectStats>;

  /**
   * Validate that the adapter is properly configured (API key set, domain configured, etc.)
   * Should be called before attempting to create links.
   */
  validateConfig(): Promise<{ valid: boolean; error?: string }>;
}
