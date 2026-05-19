/**
 * MentionInput — TextArea with `@`-mention autocomplete.
 *
 * Watches for `@<query>` immediately before the caret and opens a
 * popover of admin users (from the shared `fetchPeople()` cache).
 * On selection the partial is replaced with the canonical mention
 * markup `@[Display Name](user:uuid)` — the same format the server
 * parser at `api.ts` (`/@\[[^\]]*\]\(user:([0-9a-f-]{36})\)/g`)
 * extracts to populate `task_comments.mentions[]`.
 *
 * Keyboard:
 *   ↑/↓  — move highlight
 *   Enter — select highlighted person (suppresses default newline)
 *   Esc   — dismiss popover
 */

import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Avatar, Box, Flex, Text, TextArea } from '@radix-ui/themes';
import { fetchPeople, initials } from './AssigneePicker';
import type { Person } from '../../lib/types';

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  /** Optional id forwarded to the textarea. */
  id?: string;
}

export function MentionInput({ value, onChange, placeholder, rows = 2, disabled, id }: Props) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [queryStart, setQueryStart] = useState<number>(-1);
  const [highlighted, setHighlighted] = useState<number>(0);

  useEffect(() => {
    let aborted = false;
    fetchPeople()
      .then(list => { if (!aborted) setPeople(list); })
      .catch(() => { /* ignore — popover just won't suggest */ });
    return () => { aborted = true; };
  }, []);

  const matches = query == null ? [] : filterPeople(people, query).slice(0, 8);

  function detectQuery(text: string, caret: number) {
    // Walk back from caret to find an `@` not preceded by a word char.
    // Cancel if we hit whitespace or another `@` first.
    for (let i = caret - 1; i >= 0; i--) {
      const ch = text[i]!;
      if (ch === '@') {
        const before = i === 0 ? ' ' : text[i - 1]!;
        if (/\s/.test(before) || before === '(' || i === 0) {
          const q = text.slice(i + 1, caret);
          // Bail if the partial contains whitespace or markup chars —
          // means the user moved past the mention.
          if (/[\s\[\]()]/.test(q)) break;
          setQuery(q);
          setQueryStart(i);
          setHighlighted(0);
          return;
        }
        break;
      }
      if (/\s/.test(ch)) break;
    }
    setQuery(null);
    setQueryStart(-1);
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    onChange(next);
    detectQuery(next, e.target.selectionStart ?? next.length);
  }

  function handleKeyUp(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Re-evaluate the query when caret moves without text changes
    // (arrow keys, home/end, click placement).
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      const ta = e.currentTarget;
      detectQuery(ta.value, ta.selectionStart ?? ta.value.length);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (query == null || matches.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted(h => (h + 1) % matches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted(h => (h - 1 + matches.length) % matches.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const p = matches[highlighted];
      if (p) selectPerson(p);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setQuery(null);
    }
  }

  function selectPerson(p: Person) {
    if (queryStart < 0) return;
    const name = p.display_name ?? p.email ?? p.id;
    const marker = `@[${name}](user:${p.id}) `;
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? value.length;
    const before = value.slice(0, queryStart);
    const after = value.slice(caret);
    const next = before + marker + after;
    onChange(next);
    setQuery(null);
    setQueryStart(-1);
    // Restore caret after the inserted mention.
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      const pos = before.length + marker.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    <Box style={{ position: 'relative' }}>
      <TextArea
        ref={taRef}
        id={id}
        value={value}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBlur={() => {
          // Defer dismiss so a click on a list item registers first.
          setTimeout(() => setQuery(null), 120);
        }}
      />
      {query != null && matches.length > 0 && (
        <Box
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            zIndex: 50,
            minWidth: 220,
            maxWidth: 320,
            backgroundColor: 'var(--color-panel-solid)',
            border: '1px solid var(--gray-a6)',
            borderRadius: 'var(--radius-3)',
            boxShadow: 'var(--shadow-4)',
            padding: 4,
          }}
          onMouseDown={(e) => e.preventDefault() /* keep textarea focus */}
        >
          {matches.map((p, idx) => (
            <Flex
              key={p.id}
              align="center"
              gap="2"
              px="2"
              py="1"
              onMouseEnter={() => setHighlighted(idx)}
              onClick={() => selectPerson(p)}
              style={{
                cursor: 'pointer',
                borderRadius: 'var(--radius-2)',
                backgroundColor: idx === highlighted ? 'var(--accent-a4)' : 'transparent',
              }}
            >
              <Avatar
                size="1"
                radius="full"
                src={p.avatar_url ?? undefined}
                fallback={initials(p.display_name ?? p.email ?? '?')}
              />
              <Box style={{ minWidth: 0, flex: 1 }}>
                <Text as="div" size="2" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.display_name ?? p.email ?? p.id}
                </Text>
                {p.display_name && p.email && (
                  <Text as="div" size="1" color="gray" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.email}
                  </Text>
                )}
              </Box>
            </Flex>
          ))}
        </Box>
      )}
    </Box>
  );
}

function filterPeople(people: Person[], query: string): Person[] {
  const q = query.toLowerCase();
  if (!q) return people;
  return people.filter(p => {
    const name = (p.display_name ?? '').toLowerCase();
    const email = (p.email ?? '').toLowerCase();
    return name.includes(q) || email.includes(q);
  });
}
