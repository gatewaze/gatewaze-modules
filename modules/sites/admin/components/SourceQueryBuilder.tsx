/**
 * Generic source query builder — driven by a SourceProvider's
 * filterFields + sortOptions.
 *
 * Each per-source thin wrapper (BlogsQueryBuilder, ListsQueryBuilder,
 * EventSpeakersQueryBuilder, EventSponsorsQueryBuilder) supplies the
 * source-specific config; this component renders the filter form,
 * limit, sort, pinned-IDs picker, and live preview.
 *
 * Per spec-content-modules-git-architecture §9.5.
 *
 * The dedicated EventsQueryBuilder.tsx remains for backwards-compat
 * and as a worked-example with the live preview wired against events.
 */

import { useEffect, useState } from 'react';
import { Badge, Button, Card, Input, Select } from '@/components/ui';
import { TrashIcon } from '@heroicons/react/24/outline';
import { supabase } from '@/lib/supabase';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

export interface FieldDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'reference';
  label: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  referenceEntity?: string;
}

export interface SortOption {
  value: string;
  label: string;
}

export interface GenericQueryConfig {
  filter: Record<string, unknown>;
  sort: string;
  limit: number;
  include_specific_ids?: string[];
}

export interface SourceQueryBuilderProps {
  /** Source slug (e.g. 'blogs', 'event_speakers'). Determines DB table for live preview + pinned-search. */
  sourceSlug: string;
  /** DB table to query for the live preview / search. */
  tableName: string;
  /** Column on the table that holds the display name. */
  nameColumn: string;
  /** Optional secondary display column (e.g. date). */
  secondaryColumn?: string;
  /** Filter field definitions. */
  filterFields: FieldDefinition[];
  /** Sort options. */
  sortOptions: SortOption[];
  /** Default config when value is empty. */
  defaultConfig: GenericQueryConfig;
  /** Current per-instance config. */
  value: Partial<GenericQueryConfig>;
  /** Called on every change. */
  onChange: (config: GenericQueryConfig) => void;
  /** Optional Supabase column-mapping for sort+filter (e.g. translate sort='date_desc' → orderBy('date', desc)). */
  applySortToQuery?: (q: SupabaseQuery, sort: string) => SupabaseQuery;
  applyFilterToQuery?: (q: SupabaseQuery, filter: Record<string, unknown>) => SupabaseQuery;
}

// Narrow Supabase query shape used by the live-preview query.
// Why the inline shape: same justification as in API routes — modules
// don't ship generated Database types, and chaining methods need
// permissive return types to compose.
interface SupabaseQuery {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(cols: string): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eq(col: string, val: unknown): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ilike(col: string, val: string): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gte(col: string, val: unknown): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lt(col: string, val: unknown): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  in(col: string, vals: unknown[]): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  order(col: string, opts?: { ascending: boolean }): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  limit(n: number): any;
}

export function SourceQueryBuilder(props: SourceQueryBuilderProps) {
  const config: GenericQueryConfig = {
    ...props.defaultConfig,
    ...props.value,
    filter: { ...props.defaultConfig.filter, ...(props.value.filter ?? {}) },
  };
  const [previewItems, setPreviewItems] = useState<Array<Record<string, unknown>>>([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [pinnedSearch, setPinnedSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Array<Record<string, unknown>>>([]);

  const update = (patch: Partial<GenericQueryConfig>) => {
    props.onChange({
      ...config,
      ...patch,
      filter: { ...config.filter, ...(patch.filter ?? {}) },
    });
  };

  // Live preview
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingPreview(true);
      try {
        const cols = props.secondaryColumn
          ? `id, ${props.nameColumn}, ${props.secondaryColumn}`
          : `id, ${props.nameColumn}`;
        let q = supabase.from(props.tableName).select(cols) as unknown as SupabaseQuery;
        if (props.applyFilterToQuery) {
          q = props.applyFilterToQuery(q, config.filter);
        } else {
          for (const [k, v] of Object.entries(config.filter)) {
            if (v !== undefined && v !== '' && v !== 'all' && v !== null) {
              q = q.eq(k, v);
            }
          }
        }
        if (props.applySortToQuery) {
          q = props.applySortToQuery(q, config.sort);
        }
        q = q.limit(config.limit);
        const { data } = await q;
        if (!cancelled) setPreviewItems((data as Array<Record<string, unknown>>) ?? []);
      } catch {
        if (!cancelled) setPreviewItems([]);
      } finally {
        if (!cancelled) setLoadingPreview(false);
      }
    })();
    return () => { cancelled = true; };
  }, [JSON.stringify(config.filter), config.sort, config.limit, props.tableName]);

  // Pinned-IDs autocomplete
  useEffect(() => {
    if (!pinnedSearch.trim()) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const cols = props.secondaryColumn
        ? `id, ${props.nameColumn}, ${props.secondaryColumn}`
        : `id, ${props.nameColumn}`;
      const q = supabase
        .from(props.tableName)
        .select(cols) as unknown as SupabaseQuery;
      const { data } = await q.ilike(props.nameColumn, `%${pinnedSearch}%`).limit(10);
      if (!cancelled) setSearchResults((data as Array<Record<string, unknown>>) ?? []);
    })();
    return () => { cancelled = true; };
  }, [pinnedSearch, props.tableName, props.nameColumn]);

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
      {/* Filter fields */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {props.filterFields.map((field) => (
          <FieldInput
            key={field.name}
            field={field}
            value={config.filter[field.name]}
            onChange={(v) => update({ filter: { [field.name]: v } })}
          />
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Select
          label="Sort"
          value={config.sort}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => update({ sort: e.target.value })}
          data={props.sortOptions}
        />
        <Input
          label="Limit"
          type="number"
          value={String(config.limit)}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => update({ limit: Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 5)) })}
          min={1}
          max={50}
        />
      </div>

      {/* Pinned IDs */}
      <div>
        <p className="text-sm font-medium mb-2">Pinned (always shown)</p>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {(config.include_specific_ids ?? []).map((id) => {
            const item = [...previewItems, ...searchResults].find((x) => x.id === id);
            const name = item ? String(item[props.nameColumn]) : id.slice(0, 8);
            return (
              <span key={id} className="inline-flex items-center gap-1.5 px-2 py-1 bg-[var(--gray-a3)] rounded-md text-xs">
                {name}
                <button onClick={() => removePinned(id)} className="hover:text-red-500" aria-label={`Remove ${name}`}>
                  <TrashIcon className="size-3" />
                </button>
              </span>
            );
          })}
        </div>
        <div className="relative">
          <Input
            placeholder={`Search ${props.sourceSlug} to pin…`}
            value={pinnedSearch}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPinnedSearch(e.target.value)}
          />
          {searchResults.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-white rounded-md border border-[var(--gray-a4)] shadow-lg z-10">
              {searchResults.map((item) => (
                <button
                  key={String(item.id)}
                  onClick={() => addPinned(String(item.id))}
                  className="block w-full text-left px-3 py-2 text-sm hover:bg-[var(--gray-a3)]"
                >
                  <div>{String(item[props.nameColumn])}</div>
                  {props.secondaryColumn && (
                    <div className="text-xs text-[var(--gray-a8)]">{String(item[props.secondaryColumn] ?? '')}</div>
                  )}
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
            <Badge variant="soft" color="gray" size="1">{previewItems.length}</Badge>
          </div>
          {loadingPreview ? (
            <div className="py-4 flex justify-center"><LoadingSpinner /></div>
          ) : previewItems.length === 0 ? (
            <p className="text-sm text-[var(--gray-a8)]">No matches.</p>
          ) : (
            <ul className="space-y-1.5">
              {previewItems.map((item) => (
                <li key={String(item.id)} className="text-sm flex justify-between gap-3">
                  <span className="truncate">{String(item[props.nameColumn])}</span>
                  {props.secondaryColumn && (
                    <span className="text-[var(--gray-a8)] text-xs">{String(item[props.secondaryColumn] ?? '')}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

function FieldInput({ field, value, onChange }: { field: FieldDefinition; value: unknown; onChange: (v: unknown) => void }) {
  if (field.type === 'enum' && field.options) {
    return (
      <Select
        label={field.label}
        value={String(value ?? field.options[0]?.value ?? '')}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
        data={field.options}
      />
    );
  }
  if (field.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {field.label}
      </label>
    );
  }
  if (field.type === 'number') {
    return (
      <Input
        label={field.label}
        type="number"
        value={value !== undefined ? String(value) : ''}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    );
  }
  // string | date | reference (reference shown as plain text input — full
  // entity-picker is a v1.x enhancement)
  return (
    <Input
      label={field.label}
      value={value !== undefined && value !== null ? String(value) : ''}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value || undefined)}
      placeholder={field.type === 'date' ? 'YYYY-MM-DD' : ''}
    />
  );
}
