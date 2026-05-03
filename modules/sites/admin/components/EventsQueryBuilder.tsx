/**
 * Events source query builder — reference implementation.
 *
 * Per spec-content-modules-git-architecture §9.5: when a block declares
 * `kind="gatewaze-internal" source="events"`, the editor renders this
 * query-builder UI for the per-instance kind_config.
 *
 * The built config conforms to the events SourceProvider's filterFields
 * / sortOptions definitions and is stored in page_blocks.kind_config.
 *
 * Other source providers (blogs, lists, event_speakers, event_sponsors)
 * follow this pattern with their own field definitions; this is the
 * reference impl.
 */

import { useEffect, useState } from 'react';
import { Badge, Button, Card, Input, Select } from '@/components/ui';
import { PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import { supabase } from '@/lib/supabase';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

export type EventStatus = 'upcoming' | 'live' | 'past' | 'all';
export type EventType = 'conference' | 'meetup' | 'workshop' | 'webinar' | 'all';
export type SortKey = 'start_date_asc' | 'start_date_desc' | 'created_at_desc' | 'name_asc';

export interface EventsQueryConfig {
  filter: {
    type?: EventType;
    status?: EventStatus;
    location_country?: string;
    tags?: string[];
  };
  sort: SortKey;
  limit: number;
  /** Manually-pinned events — appended (or prepended) to the query result. */
  include_specific_ids?: string[];
}

interface EventsQueryBuilderProps {
  value: Partial<EventsQueryConfig>;
  onChange: (config: EventsQueryConfig) => void;
}

interface EventOption {
  id: string;
  name: string;
  start_date: string;
}

const DEFAULT_CONFIG: EventsQueryConfig = {
  filter: { type: 'all', status: 'upcoming' },
  sort: 'start_date_asc',
  limit: 5,
};

export function EventsQueryBuilder({ value, onChange }: EventsQueryBuilderProps) {
  const config: EventsQueryConfig = { ...DEFAULT_CONFIG, ...value, filter: { ...DEFAULT_CONFIG.filter, ...value.filter } };
  const [previewEvents, setPreviewEvents] = useState<EventOption[]>([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [pinnedSearch, setPinnedSearch] = useState('');
  const [searchResults, setSearchResults] = useState<EventOption[]>([]);

  const update = (patch: Partial<EventsQueryConfig>) => {
    onChange({ ...config, ...patch, filter: { ...config.filter, ...(patch.filter ?? {}) } });
  };

  // Live preview — fetches matching events
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingPreview(true);
      try {
        let q = supabase.from('events').select('id, name, start_date');
        if (config.filter.type && config.filter.type !== 'all') {
          q = q.eq('event_type', config.filter.type);
        }
        if (config.filter.status === 'upcoming') {
          q = q.gte('start_date', new Date().toISOString());
        } else if (config.filter.status === 'past') {
          q = q.lt('start_date', new Date().toISOString());
        }
        if (config.filter.location_country) {
          q = q.eq('location_country', config.filter.location_country);
        }
        const sortColumn = config.sort.startsWith('start_date') ? 'start_date'
          : config.sort.startsWith('created_at') ? 'created_at'
          : 'name';
        const ascending = config.sort.endsWith('_asc');
        q = q.order(sortColumn, { ascending }).limit(config.limit);
        const { data } = await q;
        if (!cancelled) setPreviewEvents((data as EventOption[]) ?? []);
      } catch {
        if (!cancelled) setPreviewEvents([]);
      } finally {
        if (!cancelled) setLoadingPreview(false);
      }
    })();
    return () => { cancelled = true; };
  }, [config.filter.type, config.filter.status, config.filter.location_country, config.sort, config.limit]);

  // Pinned-events search
  useEffect(() => {
    if (!pinnedSearch.trim()) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('events')
        .select('id, name, start_date')
        .ilike('name', `%${pinnedSearch}%`)
        .limit(10);
      if (!cancelled) setSearchResults((data as EventOption[]) ?? []);
    })();
    return () => { cancelled = true; };
  }, [pinnedSearch]);

  const addPinned = (id: string) => {
    const ids = config.include_specific_ids ?? [];
    if (ids.includes(id)) return;
    update({ include_specific_ids: [...ids, id] });
    setPinnedSearch('');
    setSearchResults([]);
  };

  const removePinned = (id: string) => {
    const ids = (config.include_specific_ids ?? []).filter((x) => x !== id);
    update({ include_specific_ids: ids });
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Select
          label="Type"
          value={config.filter.type ?? 'all'}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => update({ filter: { type: e.target.value as EventType } })}
          data={[
            { value: 'all', label: 'All types' },
            { value: 'conference', label: 'Conference' },
            { value: 'meetup', label: 'Meetup' },
            { value: 'workshop', label: 'Workshop' },
            { value: 'webinar', label: 'Webinar' },
          ]}
        />
        <Select
          label="Status"
          value={config.filter.status ?? 'upcoming'}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => update({ filter: { status: e.target.value as EventStatus } })}
          data={[
            { value: 'upcoming', label: 'Upcoming' },
            { value: 'live', label: 'Live now' },
            { value: 'past', label: 'Past' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Input
          label="Country (optional)"
          value={config.filter.location_country ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => update({ filter: { location_country: e.target.value || undefined } })}
          placeholder="e.g. US, GB, DE"
        />
        <Select
          label="Sort"
          value={config.sort}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => update({ sort: e.target.value as SortKey })}
          data={[
            { value: 'start_date_asc', label: 'Start date — soonest first' },
            { value: 'start_date_desc', label: 'Start date — latest first' },
            { value: 'created_at_desc', label: 'Most recently added' },
            { value: 'name_asc', label: 'Name (A → Z)' },
          ]}
        />
      </div>

      <Input
        label="Limit"
        type="number"
        value={String(config.limit)}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => update({ limit: Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 5)) })}
        min={1}
        max={50}
      />

      {/* Pinned events */}
      <div>
        <p className="text-sm font-medium mb-2">Pinned events (always shown)</p>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {(config.include_specific_ids ?? []).map((id) => {
            const evt = [...previewEvents, ...searchResults].find((e) => e.id === id);
            return (
              <span key={id} className="inline-flex items-center gap-1.5 px-2 py-1 bg-[var(--gray-a3)] rounded-md text-xs">
                {evt?.name ?? id.slice(0, 8)}
                <button onClick={() => removePinned(id)} className="hover:text-red-500">
                  <TrashIcon className="size-3" />
                </button>
              </span>
            );
          })}
        </div>
        <div className="relative">
          <Input
            placeholder="Search events to pin…"
            value={pinnedSearch}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPinnedSearch(e.target.value)}
          />
          {searchResults.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-white rounded-md border border-[var(--gray-a4)] shadow-lg z-10">
              {searchResults.map((evt) => (
                <button
                  key={evt.id}
                  onClick={() => addPinned(evt.id)}
                  className="block w-full text-left px-3 py-2 text-sm hover:bg-[var(--gray-a3)]"
                >
                  <div>{evt.name}</div>
                  <div className="text-xs text-[var(--gray-a8)]">{new Date(evt.start_date).toLocaleDateString()}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Live preview */}
      <Card>
        <div className="p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-medium">Live preview</span>
            <Badge variant="soft" color="gray" size="1">{previewEvents.length}</Badge>
          </div>
          {loadingPreview ? (
            <div className="py-4 flex justify-center"><LoadingSpinner /></div>
          ) : previewEvents.length === 0 ? (
            <p className="text-sm text-[var(--gray-a8)]">No events match this query.</p>
          ) : (
            <ul className="space-y-1.5">
              {previewEvents.map((evt) => (
                <li key={evt.id} className="text-sm flex justify-between gap-3">
                  <span className="truncate">{evt.name}</span>
                  <span className="text-[var(--gray-a8)] text-xs">{new Date(evt.start_date).toLocaleDateString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
