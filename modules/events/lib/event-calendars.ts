// The calendars block on public events: which public calendars an event
// belongs to. Kept out of public-api.ts so it can be tested on its own.

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * `?fields=` can name `calendars` alongside the column names; it is not a
 * column, so it is stripped before the select and attached afterwards. With
 * no `fields` param the block is always included. `id` is needed to join,
 * so it is selected even when not asked for, then removed.
 */
export function planCalendars(fieldsParam: unknown, fields: string[]) {
  const requested = typeof fieldsParam === 'string'
    ? fieldsParam.split(',').map((f) => f.trim())
    : null;
  const include = requested === null || requested.includes('calendars');
  const dropId = include && !fields.includes('id');
  return { include, dropId, select: dropId ? ['id', ...fields] : fields };
}

/**
 * Attach each event's PUBLIC calendars as `calendars: [{ id, calendar_id,
 * name, slug }]`. An event can sit in more than one calendar (a chapter and
 * the foundation-wide one), so this is a list. Private, unlisted and
 * inactive calendars are left out. If the calendars tables are missing (the
 * module is not installed), events are returned without the block.
 */
export async function attachCalendars(
  supabase: SupabaseClient,
  rows: Array<Record<string, unknown>>,
  dropId: boolean,
): Promise<void> {
  const ids = rows.map((r) => r.id).filter((v): v is string => typeof v === 'string');
  const byEvent = new Map<string, Array<Record<string, unknown>>>();
  let ok = ids.length === 0;
  if (ids.length > 0) {
    const { data, error } = await supabase
      .from('calendars_events')
      .select('event_id, calendars!inner(id, calendar_id, name, slug)')
      .in('event_id', ids)
      .eq('calendars.is_active', true)
      .eq('calendars.visibility', 'public');
    if (!error) {
      ok = true;
      type Link = { event_id: string; calendars: Record<string, unknown> | Record<string, unknown>[] | null };
      for (const link of (data ?? []) as unknown as Link[]) {
        const cals = Array.isArray(link.calendars) ? link.calendars : link.calendars ? [link.calendars] : [];
        const list = byEvent.get(link.event_id) ?? [];
        list.push(...cals);
        byEvent.set(link.event_id, list);
      }
    }
  }
  for (const row of rows) {
    if (ok) {
      row.calendars = (byEvent.get(row.id as string) ?? [])
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
    }
    if (dropId) delete row.id;
  }
}
