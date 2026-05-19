/**
 * AssigneePicker — searchable admin-user picker for task assignment.
 *
 * Uses Radix Select (single-select). For boards with many admins we
 * could swap to a Popover + search input later; for v1 the platform's
 * 500-row cap on `/people` is enough.
 */

import { useEffect, useState } from 'react';
import { Avatar, Flex, Select, Spinner, Text } from '@radix-ui/themes';
import { listPeople } from '../lib/api-client';
import type { Person, Uuid } from '../../lib/types';

interface Props {
  value: Uuid | null;
  onChange: (id: Uuid | null) => void;
  placeholder?: string;
  /** Stretch trigger to fill its container. */
  fullWidth?: boolean;
}

// Cache people across the session so every Assignee/Mention picker
// doesn't re-fetch. Invalidated on full page reload.
let _peopleCache: Person[] | null = null;
let _peoplePromise: Promise<Person[]> | null = null;

export async function fetchPeople(): Promise<Person[]> {
  if (_peopleCache) return _peopleCache;
  if (_peoplePromise) return _peoplePromise;
  _peoplePromise = listPeople().then(r => {
    _peopleCache = r.data;
    _peoplePromise = null;
    return r.data;
  });
  return _peoplePromise;
}

export function clearPeopleCache(): void {
  _peopleCache = null;
}

export function AssigneePicker({ value, onChange, placeholder = 'Unassigned', fullWidth }: Props) {
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let aborted = false;
    fetchPeople()
      .then(list => { if (!aborted) setPeople(list); })
      .catch(() => { if (!aborted) setPeople([]); })
      .finally(() => { if (!aborted) setLoading(false); });
    return () => { aborted = true; };
  }, []);

  return (
    <Select.Root
      value={value ?? '__unassigned__'}
      onValueChange={(v) => onChange(v === '__unassigned__' ? null : v)}
    >
      <Select.Trigger placeholder={placeholder} style={fullWidth ? { width: '100%' } : undefined} />
      <Select.Content>
        <Select.Item value="__unassigned__">
          <Text size="2" color="gray">Unassigned</Text>
        </Select.Item>
        {loading && (
          <Flex align="center" gap="2" px="2" py="2">
            <Spinner size="1" />
            <Text size="1" color="gray">Loading users…</Text>
          </Flex>
        )}
        {!loading && people.map(p => (
          <Select.Item key={p.id} value={p.id}>
            <Flex align="center" gap="2">
              <Avatar
                size="1"
                radius="full"
                src={p.avatar_url ?? undefined}
                fallback={initials(p.display_name ?? p.email ?? '?')}
              />
              <Text size="2">{p.display_name ?? p.email ?? p.id}</Text>
            </Flex>
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

export function initials(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
}
