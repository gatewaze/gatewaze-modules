/**
 * Labels for a condition's stored entity when it is missing from the loaded
 * vocabulary. The catalog returns at most `p_entity_limit` entities (200,
 * newest first), so an audience that names an older event showed "Select…"
 * even though the condition still held that event and still matched on it.
 * The builder now looks the stored entity up and shows it as the selection.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EventRow {
  event_title: string | null;
  event_start: string | null;
}

/** Fetch one event by its UUID (`id`) or its short code (`event_id`). */
export type EventLookup = (column: 'id' | 'event_id', value: string) => Promise<EventRow | null>;

/** Same shape as the catalog's event vocabulary: "Title — YYYY-MM-DD". */
export function formatEventLabel(row: EventRow): string | null {
  const title = row.event_title?.trim();
  if (!title) return null;
  const date = row.event_start ? row.event_start.slice(0, 10) : '';
  return date ? `${title} — ${date}` : title;
}

/**
 * The label for a stored entity id, or null when this kind has no lookup or
 * the entity no longer exists. Only event registrations are resolved today;
 * other kinds fall back to the caller's generic label.
 */
export async function resolveEntityLabel(kind: string, id: string, lookupEvent: EventLookup): Promise<string | null> {
  if (kind !== 'event_registration' || !id) return null;
  // event_registration accepts the event UUID or its short code (migration 011).
  const row = await lookupEvent(UUID_RE.test(id) ? 'id' : 'event_id', id);
  return row ? formatEventLabel(row) : null;
}

/** Shown when the stored entity can't be named (unknown kind, or deleted). */
export function fallbackEntityLabel(sourceLabel: string, id: string): string {
  return `${sourceLabel}: ${id.length > 12 ? `${id.slice(0, 8)}…` : id} (not in the list above)`;
}
