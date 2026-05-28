/**
 * Per-turn URL → FetchResult cache. Spec §6.8.
 *
 * Lives for the duration of a single chat turn. Never persisted —
 * second identical fetch in one turn returns the cached bytes and
 * is not billed against per-turn caps or cost budget.
 *
 * Construct one per turn; discard when the turn returns.
 */

import type { FetchResult } from './types.js';
import { canonicaliseUrl } from './canonicalise-url.js';

export class TurnFetchCache {
  private readonly entries = new Map<string, FetchResult>();

  /** Return a cached result for `url`, or undefined if no entry. */
  get(url: string): FetchResult | undefined {
    return this.entries.get(canonicaliseUrl(url));
  }

  /** Store a result for `url`. Idempotent — last write wins. */
  set(url: string, result: FetchResult): void {
    this.entries.set(canonicaliseUrl(url), result);
  }

  has(url: string): boolean {
    return this.entries.has(canonicaliseUrl(url));
  }

  size(): number {
    return this.entries.size;
  }
}
