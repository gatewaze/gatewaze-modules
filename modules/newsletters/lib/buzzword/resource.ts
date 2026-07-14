/**
 * Find-or-create the structured-resource item the leaderboard is written to,
 * and upsert its section HTML.
 *
 * Turnkey by design: if no `resource_item_id` is configured, the worker
 * auto-provisions a "Downtime" collection → "AI Buzzword Leaderboard" item →
 * single "Leaderboard" section by slug, so the feature works on a fresh
 * deploy with zero manual setup. Everything is keyed by slug, so it is
 * idempotent — re-running never duplicates rows.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = { from(table: string): any };

const COLLECTION_SLUG = 'downtime';
const COLLECTION_NAME = 'Downtime';
const CATEGORY_SLUG = 'leaderboards';
const CATEGORY_NAME = 'Leaderboards';
const ITEM_SLUG = 'ai-buzzword-leaderboard';
const ITEM_TITLE = 'AI Buzzword Leaderboard';
const ITEM_SUBTITLE = 'The phrases the community hears most in AI right now — from your newsletter replies.';
const SECTION_HEADING = 'Leaderboard';

export interface LeaderboardTarget {
  itemId: string;
  sectionId: string;
  /**
   * True when the item was resolved via slug auto-provision (no configured
   * item id). The worker pins `itemId` back into config on the first such
   * run, so a later rename of the collection/item — which changes its slug —
   * can never make the next tick re-provision a duplicate.
   */
  autoProvisioned: boolean;
}

async function findOrCreate(
  supabase: SupabaseLike,
  table: string,
  match: Record<string, unknown>,
  insert: Record<string, unknown>,
): Promise<{ id: string } | null> {
  let q = supabase.from(table).select('id');
  for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
  const found = await q.maybeSingle();
  if (found?.data?.id) return found.data as { id: string };

  const created = await supabase.from(table).insert(insert).select('id').maybeSingle();
  if (created?.data?.id) return created.data as { id: string };
  // Lost a create race — re-read.
  let q2 = supabase.from(table).select('id');
  for (const [k, v] of Object.entries(match)) q2 = q2.eq(k, v);
  const reread = await q2.maybeSingle();
  return (reread?.data as { id: string } | null) ?? null;
}

/**
 * Resolve the leaderboard target. If `configuredItemId` is set, use it (and
 * ensure it has a section to write). Otherwise auto-provision by slug.
 */
export async function ensureLeaderboardTarget(
  supabase: SupabaseLike,
  configuredItemId?: string | null,
): Promise<LeaderboardTarget | null> {
  let itemId = configuredItemId ?? null;
  const autoProvisioned = !itemId;

  if (!itemId) {
    const collection = await findOrCreate(
      supabase,
      'sr_collections',
      { slug: COLLECTION_SLUG },
      {
        slug: COLLECTION_SLUG,
        name: COLLECTION_NAME,
        description: 'What the community is hearing, saying, and building right now.',
        status: 'published',
      },
    );
    if (!collection) return null;

    const category = await findOrCreate(
      supabase,
      'sr_categories',
      { collection_id: collection.id, slug: CATEGORY_SLUG },
      { collection_id: collection.id, slug: CATEGORY_SLUG, name: CATEGORY_NAME },
    );
    if (!category) return null;

    const item = await findOrCreate(
      supabase,
      'sr_items',
      { collection_id: collection.id, slug: ITEM_SLUG },
      {
        collection_id: collection.id,
        category_id: category.id,
        slug: ITEM_SLUG,
        title: ITEM_TITLE,
        subtitle: ITEM_SUBTITLE,
        status: 'published',
        publish_state: 'published',
      },
    );
    if (!item) return null;
    itemId = item.id;
  }

  // Ensure a single section to hold the rendered HTML.
  const section = await findOrCreate(
    supabase,
    'sr_sections',
    { item_id: itemId, heading: SECTION_HEADING },
    { item_id: itemId, heading: SECTION_HEADING, sort_order: 0 },
  );
  if (!section) return null;

  return { itemId, sectionId: section.id, autoProvisioned };
}

/**
 * Pin an auto-provisioned item id into installed_modules.config so future
 * ticks use it directly instead of matching by slug. Makes the turnkey path
 * survive a later rename (which changes the slug) without re-provisioning.
 */
export async function pinResourceItemId(supabase: SupabaseLike, itemId: string): Promise<void> {
  const res = await supabase.from('installed_modules').select('config').eq('id', 'newsletters').maybeSingle();
  const config = ((res?.data as { config?: Record<string, unknown> } | null)?.config ?? {}) as Record<string, unknown>;
  const buzzword = { ...((config['buzzword'] as Record<string, unknown>) ?? {}), resource_item_id: itemId };
  await supabase
    .from('installed_modules')
    .update({ config: { ...config, buzzword } })
    .eq('id', 'newsletters');
}

/** Write the rendered leaderboard HTML into the section and touch the item. */
export async function writeLeaderboardHtml(
  supabase: SupabaseLike,
  target: LeaderboardTarget,
  html: string,
): Promise<void> {
  const now = new Date().toISOString();
  await supabase
    .from('sr_sections')
    .update({ content: html, updated_at: now })
    .eq('id', target.sectionId);
  // Bump the item so portal "updated" ordering reflects the refresh.
  await supabase.from('sr_items').update({ updated_at: now }).eq('id', target.itemId);
}
