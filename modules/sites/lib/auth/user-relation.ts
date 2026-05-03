/**
 * Cross-module user-relation helper.
 *
 * Per spec-content-modules-git-architecture §12.5:
 *
 *   const reg = useUserRelation('event', eventId);
 *   // → { type: 'event', registered: true, registeredAt: '...' }
 *   //   | { type: 'event', registered: false }
 *
 * Modules register a relation provider at platform-init time:
 *
 *   gatewazeRelationProvider({
 *     entity: 'event',
 *     resolve: async (entityId, user) => ({ registered: ..., registeredAt: ... }),
 *   });
 *
 * Each module exposes the relations it owns:
 *   events           → registered, attended, is_speaker
 *   lists            → subscribed, subscription_pending
 *   event_sponsors   → is_sponsor
 *   event_speakers   → is_speaker
 *
 * Extension point — new modules add new relation kinds.
 */

export interface UserContext {
  id: string;
  email: string;
  // Platform may attach more (full_name, avatar_url, etc.)
}

export interface RelationProviderArgs {
  entityId: string;
  user: UserContext;
}

export interface RelationResult {
  /** True if the user has any relation to the entity. */
  hasRelation: boolean;
  /** Free-form attributes (registered, attended, subscribedAt, etc.) per provider's schema. */
  attributes: Record<string, unknown>;
}

export type RelationProvider = (args: RelationProviderArgs) => Promise<RelationResult>;

class RelationRegistry {
  private providers = new Map<string, RelationProvider>();

  register(entity: string, provider: RelationProvider): void {
    if (this.providers.has(entity)) {
      throw new Error(`gatewazeRelationProvider: entity '${entity}' already registered`);
    }
    this.providers.set(entity, provider);
  }

  get(entity: string): RelationProvider | null {
    return this.providers.get(entity) ?? null;
  }

  list(): string[] {
    return [...this.providers.keys()].sort();
  }
}

const registry = new RelationRegistry();

export function gatewazeRelationProvider(entity: string, provider: RelationProvider): void {
  registry.register(entity, provider);
}

/**
 * Server-side resolution. The SSR `useUserRelation` hook calls this with the
 * current request's user context.
 */
export async function resolveUserRelation(
  entity: string,
  entityId: string,
  user: UserContext | null,
): Promise<RelationResult> {
  if (!user) {
    return { hasRelation: false, attributes: {} };
  }
  const provider = registry.get(entity);
  if (!provider) {
    throw new Error(
      `useUserRelation: no provider registered for entity '${entity}'. ` +
      `Available: ${registry.list().join(', ') || '(none)'}. ` +
      `Modules register via gatewazeRelationProvider() at platform-init time.`,
    );
  }
  return provider({ entityId, user });
}

/**
 * Multi-entity batch resolver. Used by `useUserRelations`.
 */
export async function resolveUserRelations(
  entity: string,
  entityIds: string[],
  user: UserContext | null,
): Promise<Map<string, RelationResult>> {
  const result = new Map<string, RelationResult>();
  if (!user || entityIds.length === 0) return result;
  // Default impl: parallel single resolves. Providers can register a
  // resolveBatch override in v1.x if N+1 becomes a problem.
  await Promise.all(
    entityIds.map(async (id) => {
      result.set(id, await resolveUserRelation(entity, id, user));
    }),
  );
  return result;
}

/**
 * Inspection — used by admin tools to show registered providers.
 */
export function listRegisteredEntities(): string[] {
  return registry.list();
}
