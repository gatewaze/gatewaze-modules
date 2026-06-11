/**
 * Search box for the newsletter Puck editor's Blocks drawer.
 *
 * Puck ships no built-in component search, so this is wired in as the
 * `components` override (CanvasShell merges it into Puck's overrides). The
 * override wraps the default block list: it renders a search input, and while
 * a query is active it replaces the categorised list with a flat, filtered
 * list of draggable `Drawer.Item`s (matching on label or component id). With
 * no query it falls through to Puck's default categorised drawer.
 *
 * Query state is local to this component — it only re-renders the drawer, not
 * the whole editor — so no context/provider is needed.
 */

import { useState, type ReactNode } from 'react';
import { createUsePuck, Drawer } from '@puckeditor/core';

const usePuck = createUsePuck();

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 10px',
  marginBottom: 8,
  fontSize: 13,
  border: '1px solid var(--puck-color-grey-09, #d1d5db)',
  borderRadius: 6,
  background: 'var(--puck-color-white, #fff)',
  color: 'inherit',
  outline: 'none',
};

export function BlockSearchComponents({ children }: { children: ReactNode }): ReactNode {
  const [query, setQuery] = useState('');
  const components = usePuck(
    (s) => (s.config.components ?? {}) as Record<string, { label?: string }>,
  );

  const q = query.trim().toLowerCase();
  const matches = q
    ? Object.entries(components).filter(([key, c]) => {
        const label = (c.label ?? key).toLowerCase();
        return label.includes(q) || key.toLowerCase().includes(q);
      })
    : null;

  return (
    <div>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search blocks…"
        aria-label="Search blocks"
        style={INPUT_STYLE}
      />
      {matches === null ? (
        children
      ) : matches.length > 0 ? (
        <Drawer>
          {matches.map(([key, c]) => (
            <Drawer.Item key={key} name={key} label={c.label ?? key} />
          ))}
        </Drawer>
      ) : (
        <div style={{ padding: '8px 4px', fontSize: 12, color: 'var(--puck-color-grey-05, #888)' }}>
          No blocks match “{query}”.
        </div>
      )}
    </div>
  );
}
