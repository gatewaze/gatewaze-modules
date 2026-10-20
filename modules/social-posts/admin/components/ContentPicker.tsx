import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowTopRightOnSquareIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { Badge, Button, Card, Checkbox, Input, Skeleton } from '@/components/ui';
import type { PoolItem, PoolType } from '../../lib/pool-types';
import { socialPostsService } from '../utils/socialPostsService';

export interface SelectedItem {
  content_type: PoolType;
  content_id: string;
  title: string;
  typeLabel: string;
  url: string | null;
}

export const keyOf = (i: { content_type: string; content_id: string }) => `${i.content_type}::${i.content_id}`;

const TYPE_LABELS: Record<PoolType, string> = {
  blog_post: 'Blog posts & articles',
  video: 'Videos',
  event: 'Events',
  sr_item: 'Resources & recaps',
};

interface Props {
  selected: Map<string, SelectedItem>;
  onToggle: (item: SelectedItem) => void;
}

export function ContentPicker({ selected, onToggle }: Props) {
  const [items, setItems] = useState<PoolItem[] | null>(null);
  const [available, setAvailable] = useState<PoolType[]>([]);
  const [type, setType] = useState<PoolType | 'all'>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<PoolType[]>([]);
  const requestId = useRef(0);

  // Debounce typing into the query the list loads with.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setItems(null);
    setError(null);
    try {
      const r = await socialPostsService.pool({ types: type === 'all' ? undefined : [type], q: query || undefined, limit: 60 });
      if (id !== requestId.current) return;
      setItems(r.items);
      setFailed(r.failed ?? []);
      if (type === 'all') setAvailable(r.available);
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : 'Could not load content');
      setItems([]);
    }
  }, [type, query]);

  useEffect(() => { void load(); }, [load]);

  return (
    <Card className="p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-[var(--gray-12)]">Curated content</h2>
        <p className="text-xs text-[var(--gray-a10)] mt-0.5">
          Published items from the Content Inbox. Pick one or more to write about.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Button size="1" variant={type === 'all' ? 'solid' : 'soft'} color="gray" onClick={() => setType('all')}>All</Button>
        {available.map((t) => (
          <Button key={t} size="1" variant={type === t ? 'solid' : 'soft'} color="gray" onClick={() => setType(t)}>
            {TYPE_LABELS[t]}
          </Button>
        ))}
      </div>

      <Input
        placeholder="Search titles"
        value={search}
        prefix={<MagnifyingGlassIcon className="size-4" />}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
      />

      {error && <p className="text-sm text-[var(--red-11)]">{error}</p>}
      {failed.length > 0 && (
        <p className="text-sm text-[var(--orange-11)]">
          Could not load {failed.map((t) => TYPE_LABELS[t].toLowerCase()).join(', ')} just now. The list may be missing items; try again shortly.
        </p>
      )}

      <div className="max-h-[32rem] overflow-y-auto -mx-1 px-1 divide-y divide-[var(--gray-a4)]">
        {items === null && Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="py-3"><Skeleton className="h-10 w-full rounded" /></div>
        ))}
        {items?.length === 0 && !error && failed.length === 0 && (
          <p className="py-6 text-center text-sm text-[var(--gray-a10)]">
            {query ? 'Nothing published matches that search.' : 'Nothing published yet. Approve items in the Content Inbox first.'}
          </p>
        )}
        {items?.map((item) => {
          const k = keyOf({ content_type: item.contentType, content_id: item.contentId });
          const checked = selected.has(k);
          return (
            <label key={k} className="flex gap-3 py-2.5 cursor-pointer items-start">
              <Checkbox
                checked={checked}
                onChange={() => onToggle({ content_type: item.contentType, content_id: item.contentId, title: item.title, typeLabel: item.typeLabel, url: item.url })}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-start gap-1.5">
                  <span className="text-sm font-medium text-[var(--gray-12)] line-clamp-2">{item.title}</span>
                  {item.url && (
                    <a href={item.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
                      className="shrink-0 text-[var(--gray-a9)] hover:text-[var(--accent-11)]" aria-label="Open the item in a new tab">
                      <ArrowTopRightOnSquareIcon className="size-3.5 mt-0.5" />
                    </a>
                  )}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--gray-a10)]">
                  <Badge color="gray" variant="soft" size="1">{item.typeLabel}</Badge>
                  {item.date && <span>{item.date}</span>}
                  {item.location && <span>· {item.location}</span>}
                  {item.members.slice(0, 3).map((m) => (
                    <Badge key={m} color="green" variant="soft" size="1">Member: {m}</Badge>
                  ))}
                  {item.members.length > 3 && <span>+{item.members.length - 3} members</span>}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </Card>
  );
}
