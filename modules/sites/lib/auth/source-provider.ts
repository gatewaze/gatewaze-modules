/**
 * Source provider registry — for `gatewaze-internal` block kind.
 *
 * Per spec-content-modules-git-architecture §9.1:
 *
 *   gatewazeSourceProvider({
 *     slug: 'events',
 *     displayName: 'Events',
 *     configSchema: { ... },
 *     filterFields: [ ... ],
 *     sortOptions: [ ... ],
 *     supportedAudiences: ['public', 'authenticated'],
 *     fetch: async (config, ctx) => { ... },
 *   });
 *
 * The editor's query-builder UI reads `configSchema` + `filterFields` +
 * `sortOptions` to render a per-source form. At publish time (or SSR time
 * for `freshness=live`), the publisher calls `provider.fetch(config, ctx)`.
 */

import type { UserContext } from './user-relation.js';

export interface FieldDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'reference';
  label: string;
  required?: boolean;
  /** For type=enum: list of allowed values + display labels. */
  options?: Array<{ value: string; label: string }>;
  /** For type=reference: the target entity slug (e.g. 'event_speakers'). */
  referenceEntity?: string;
}

export interface SortOption {
  value: string;
  label: string;
}

export type Audience = 'public' | 'authenticated' | 'authenticated_optional';

export interface SourceProvider<TFilter = unknown, TRow = unknown> {
  /** Source slug (matches the marker `source="..."` value). Unique per install. */
  slug: string;
  /** Display name shown in the query-builder UI. */
  displayName: string;
  /** JSON Schema for the kind_config form rendered in the editor. */
  configSchema: Record<string, unknown>;
  /** Field definitions for the query-builder filter widgets. */
  filterFields: FieldDefinition[];
  /** Sort options exposed in the editor. */
  sortOptions: SortOption[];
  /** Audience constraints — which `audience` values this source supports. */
  supportedAudiences: Audience[];
  /** Fetch data given a per-instance config and the requesting user's session. */
  fetch(config: TFilter, ctx: { user: UserContext | null; siteId: string }): Promise<TRow[]>;
  /** Subscribe to source-data change events for cache invalidation (live mode). */
  subscribeInvalidations?(handler: (affectedFilter: Partial<TFilter>) => void): () => void;
}

class SourceProviderRegistry {
  private providers = new Map<string, SourceProvider>();

  register<TFilter, TRow>(provider: SourceProvider<TFilter, TRow>): void {
    if (this.providers.has(provider.slug)) {
      throw new Error(`gatewazeSourceProvider: source '${provider.slug}' already registered`);
    }
    this.providers.set(provider.slug, provider as SourceProvider);
  }

  get(slug: string): SourceProvider | null {
    return this.providers.get(slug) ?? null;
  }

  list(): SourceProvider[] {
    return [...this.providers.values()];
  }
}

const registry = new SourceProviderRegistry();

export function gatewazeSourceProvider<TFilter = unknown, TRow = unknown>(
  provider: SourceProvider<TFilter, TRow>,
): void {
  registry.register(provider);
}

export function getSourceProvider(slug: string): SourceProvider | null {
  return registry.get(slug);
}

export function listSourceProviders(): SourceProvider[] {
  return registry.list();
}
