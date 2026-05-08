/**
 * Add Block modal — full-screen-ish overlay listing every block_def in
 * the site's library as clickable cards. Sits alongside the sidebar
 * BlockPalette; meant for the "+ Add Block" CTA at the top of the
 * canvas, which is more discoverable than the dense sidebar list.
 */

import { useEffect, useMemo, useState } from 'react';
import { Modal, Input } from '@/components/ui';
import { MagnifyingGlassIcon, RectangleStackIcon, RectangleGroupIcon, CodeBracketSquareIcon, MinusIcon } from '@heroicons/react/24/outline';
import { CanvasService } from './canvas-service.js';

interface BlockDefSummary {
  key: string;
  name: string;
  description?: string | null;
  has_bricks?: boolean | null;
  thumbnail_url?: string | null;
}

interface AddBlockModalProps {
  isOpen: boolean;
  onClose: () => void;
  libraryId: string;
  onInsert: (blockDefKey: string) => void;
  disabled?: boolean;
}

const LAYOUT_KEYS = new Set(['two_columns', 'three_columns', 'columns', 'spacer', 'divider', 'section']);

function iconFor(def: BlockDefSummary) {
  if (def.key === 'spacer') return <MinusIcon className="size-6 text-[var(--gray-a8)]" />;
  if (def.has_bricks) return <RectangleGroupIcon className="size-6 text-[var(--gray-a8)]" />;
  if (LAYOUT_KEYS.has(def.key)) return <RectangleStackIcon className="size-6 text-[var(--gray-a8)]" />;
  return <CodeBracketSquareIcon className="size-6 text-[var(--gray-a8)]" />;
}

export function AddBlockModal({ isOpen, onClose, libraryId, onInsert, disabled }: AddBlockModalProps) {
  const [blockDefs, setBlockDefs] = useState<ReadonlyArray<BlockDefSummary> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void CanvasService.listBlockDefs(libraryId).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setBlockDefs(r.blockDefs);
      } else {
        setError(r.error.message);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [isOpen, libraryId]);

  const grouped = useMemo(() => {
    if (!blockDefs) return { layout: [], content: [] };
    const filter = (d: BlockDefSummary) =>
      !search ||
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      d.key.toLowerCase().includes(search.toLowerCase()) ||
      (d.description ?? '').toLowerCase().includes(search.toLowerCase());
    const layout: BlockDefSummary[] = [];
    const content: BlockDefSummary[] = [];
    for (const d of blockDefs.filter(filter)) {
      if (LAYOUT_KEYS.has(d.key)) layout.push(d);
      else content.push(d);
    }
    return { layout, content };
  }, [blockDefs, search]);

  const handleInsert = (key: string) => {
    onInsert(key);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add a block"
      width="lg"
    >
      <div className="space-y-4">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-[var(--gray-a8)] pointer-events-none" />
          <Input
            placeholder="Search blocks…"
            value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
            className="pl-9"
            autoFocus
          />
        </div>

        {loading && <p className="text-sm text-[var(--gray-a8)] py-8 text-center">Loading…</p>}
        {error && <p className="text-sm text-[var(--error-11)] py-4">{error}</p>}

        {!loading && blockDefs && blockDefs.length === 0 && (
          <div className="py-8 text-center">
            <p className="text-sm font-medium text-[var(--gray-12)]">No blocks in this library</p>
            <p className="mt-1 text-xs text-[var(--gray-a9)]">
              Connect a theme git repo from the Source tab (e.g. <span className="font-mono">gatewaze-template-site</span>)
              to populate the block library.
            </p>
          </div>
        )}

        {grouped.layout.length > 0 && (
          <Section title="Layout" defs={grouped.layout} onClick={handleInsert} disabled={disabled} />
        )}
        {grouped.content.length > 0 && (
          <Section title="Content" defs={grouped.content} onClick={handleInsert} disabled={disabled} />
        )}

        {!loading && blockDefs && blockDefs.length > 0 && grouped.layout.length === 0 && grouped.content.length === 0 && (
          <p className="text-sm text-[var(--gray-a8)] py-4 text-center">No matches for &ldquo;{search}&rdquo;.</p>
        )}
      </div>
    </Modal>
  );
}

function Section({
  title,
  defs,
  onClick,
  disabled,
}: {
  title: string;
  defs: ReadonlyArray<BlockDefSummary>;
  onClick: (key: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--gray-a9)] mb-2 px-1">{title}</h4>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {defs.map((def) => (
          <button
            key={def.key}
            type="button"
            disabled={disabled}
            onClick={() => onClick(def.key)}
            className="group text-left p-3 rounded-md border border-[var(--gray-a4)] hover:border-[var(--accent-9)] hover:bg-[var(--accent-a2)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-start gap-3">
              <div className="shrink-0 mt-0.5">{iconFor(def)}</div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-[var(--gray-12)] truncate">{def.name}</div>
                {def.description && (
                  <div className="text-xs text-[var(--gray-a9)] mt-0.5 line-clamp-2">{def.description}</div>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export default AddBlockModal;
