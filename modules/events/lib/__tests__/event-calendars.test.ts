import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { attachCalendars, planCalendars } from '../event-calendars';

// Records the query and resolves to a canned result, like a PostgREST builder.
function fakeSupabase(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, ...unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'in', 'eq']) {
    builder[m] = (...args: unknown[]) => { calls.push([m, ...args]); return builder; };
  }
  builder.then = (resolve: (v: unknown) => void) => resolve(result);
  const client = { from: (t: string) => { calls.push(['from', t]); return builder; } };
  return { client: client as unknown as SupabaseClient, calls };
}

describe('planCalendars', () => {
  it('includes the block when no fields param is given', () => {
    expect(planCalendars(undefined, ['id', 'event_title'])).toEqual({
      include: true, dropId: false, select: ['id', 'event_title'],
    });
  });

  it('leaves the block out when fields does not name it', () => {
    expect(planCalendars('event_title', ['event_title'])).toEqual({
      include: false, dropId: false, select: ['event_title'],
    });
  });

  it('selects id for the join when fields names calendars but not id', () => {
    expect(planCalendars('event_title, calendars', ['event_title'])).toEqual({
      include: true, dropId: true, select: ['id', 'event_title'],
    });
  });
});

describe('attachCalendars', () => {
  it('attaches public calendars per event, sorted by name, and asks only for public active ones', async () => {
    const { client, calls } = fakeSupabase({
      data: [
        { event_id: 'e1', calendars: { id: 'c2', calendar_id: 'CAL-AAIFLONDON', name: 'AAIF London Chapter', slug: 'aaif-london' } },
        { event_id: 'e1', calendars: { id: 'c1', calendar_id: 'CAL-AAIF', name: 'AAIF', slug: 'aaif' } },
      ],
      error: null,
    });
    const rows: Array<Record<string, unknown>> = [{ id: 'e1' }, { id: 'e2' }];
    await attachCalendars(client, rows, false);

    expect(rows[0].calendars).toEqual([
      { id: 'c1', calendar_id: 'CAL-AAIF', name: 'AAIF', slug: 'aaif' },
      { id: 'c2', calendar_id: 'CAL-AAIFLONDON', name: 'AAIF London Chapter', slug: 'aaif-london' },
    ]);
    expect(rows[1].calendars).toEqual([]);
    expect(calls).toContainEqual(['from', 'calendars_events']);
    expect(calls).toContainEqual(['in', 'event_id', ['e1', 'e2']]);
    expect(calls).toContainEqual(['eq', 'calendars.is_active', true]);
    expect(calls).toContainEqual(['eq', 'calendars.visibility', 'public']);
    // The webhook secret and other calendar columns are never selected.
    const select = calls.find((c) => c[0] === 'select')?.[1] as string;
    expect(select).toBe('event_id, calendars!inner(id, calendar_id, name, slug)');
  });

  it('removes the id it added for the join', async () => {
    const { client } = fakeSupabase({ data: [], error: null });
    const rows: Array<Record<string, unknown>> = [{ id: 'e1', event_title: 'Meetup' }];
    await attachCalendars(client, rows, true);
    expect(rows[0]).toEqual({ event_title: 'Meetup', calendars: [] });
  });

  it('omits the block, rather than claiming no calendars, when the query fails', async () => {
    const { client } = fakeSupabase({ data: null, error: { message: 'relation "calendars_events" does not exist' } });
    const rows: Array<Record<string, unknown>> = [{ id: 'e1' }];
    await attachCalendars(client, rows, false);
    expect(rows[0]).not.toHaveProperty('calendars');
  });
});
