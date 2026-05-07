/**
 * Block palette — left rail. Lists block_defs available in the site's
 * bound library, click-to-insert at end. Drag-from-palette is deferred
 * to a follow-up session (cross-iframe DnD is the iframe-message
 * choreography that's complex enough to deserve its own pass).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  CodeBracketSquareIcon,
  RectangleStackIcon,
  RectangleGroupIcon,
  MinusIcon,
  BookmarkSquareIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { Button, Card } from '@/components/ui';
import { CanvasService, type BlockDefSummary, type PresetSummary } from './canvas-service.js';

interface BlockPaletteProps {
  libraryId: string;
  siteSlug: string;
  /** Called when user clicks a palette entry. Invokes a block.insert op
   *  appended at the end of the page (parentBrickId=null, afterBlockId=last). */
  onInsert: (blockDefKey: string) => void;
  /** Called when user clicks a preset. Invokes a preset.apply op. */
  onApplyPreset: (presetId: string) => void;
  /** Bumped after a save-preset to trigger a refetch of the presets list. */
  presetsRefreshKey: number;
  /** Disabled state — true while an op is in flight or no lock is held. */
  disabled?: boolean;
}

const LAYOUT_KEYS = new Set(['section', 'row-2col', 'row-3col', 'row-4col', 'spacer']);

function iconForBlock(def: BlockDefSummary): React.ReactNode {
  if (def.key === 'spacer') return <MinusIcon className="size-5 text-[var(--gray-a8)]" />;
  if (def.has_bricks) return <RectangleGroupIcon className="size-5 text-[var(--gray-a8)]" />;
  if (LAYOUT_KEYS.has(def.key)) return <RectangleStackIcon className="size-5 text-[var(--gray-a8)]" />;
  return <CodeBracketSquareIcon className="size-5 text-[var(--gray-a8)]" />;
}

export function BlockPalette({ libraryId, siteSlug, onInsert, onApplyPreset, presetsRefreshKey, disabled }: BlockPaletteProps) {
  const [blockDefs, setBlockDefs] = useState<ReadonlyArray<BlockDefSummary> | null>(null);
  const [presets, setPresets] = useState<ReadonlyArray<PresetSummary> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, [libraryId]);

  useEffect(() => {
    let cancelled = false;
    void CanvasService.listPresets(siteSlug).then((r) => {
      if (cancelled) return;
      if (r.ok) setPresets(r.presets);
      // Don't surface errors for presets — palette renders without them.
    });
    return () => { cancelled = true; };
  }, [siteSlug, presetsRefreshKey]);

  const onDeletePreset = async (presetId: string) => {
    await CanvasService.deletePreset(siteSlug, presetId);
    if (presets) setPresets(presets.filter((p) => p.id !== presetId));
  };

  const { layouts, contentBlocks } = useMemo(() => {
    if (!blockDefs) return { layouts: [], contentBlocks: [] };
    const layouts: BlockDefSummary[] = [];
    const contentBlocks: BlockDefSummary[] = [];
    for (const d of blockDefs) {
      if (LAYOUT_KEYS.has(d.key)) layouts.push(d);
      else contentBlocks.push(d);
    }
    return { layouts, contentBlocks };
  }, [blockDefs]);

  return (
    <Card>
      <div className="p-3 space-y-4">
        <h3 className="text-sm font-semibold text-[var(--gray-12)] px-1">Blocks</h3>
        {loading && <p className="px-1 text-xs text-[var(--gray-a8)]">Loading…</p>}
        {error && <p className="px-1 text-xs text-[var(--error-11)]">{error}</p>}
        {!loading && blockDefs && blockDefs.length === 0 && (
          <p className="px-1 text-xs text-[var(--gray-a8)]">
            No canvas-validated blocks in this library yet. Connect a theme git source or run the
            template validator to enable blocks.
          </p>
        )}
        {layouts.length > 0 && (
          <PaletteSection title="Layout" defs={layouts} onInsert={onInsert} disabled={disabled} />
        )}
        {contentBlocks.length > 0 && (
          <PaletteSection title="Content" defs={contentBlocks} onInsert={onInsert} disabled={disabled} />
        )}
        {presets && presets.length > 0 && (
          <PresetsSection
            presets={presets}
            onApply={onApplyPreset}
            onDelete={onDeletePreset}
            disabled={disabled}
          />
        )}
      </div>
    </Card>
  );
}

function PresetsSection({
  presets, onApply, onDelete, disabled,
}: {
  presets: ReadonlyArray<PresetSummary>;
  onApply: (id: string) => void;
  onDelete: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <h4 className="px-1 text-[11px] uppercase tracking-wide text-[var(--gray-a8)]">Presets</h4>
      <ul className="space-y-1">
        {presets.map((p) => (
          <li key={p.id} className="group flex items-center gap-1">
            <button
              type="button"
              onClick={() => onApply(p.id)}
              disabled={disabled || !p.applicable}
              className="flex-1 flex items-center gap-2 px-2 py-2 rounded-md hover:bg-[var(--gray-a3)] disabled:opacity-50 disabled:cursor-not-allowed text-left transition-colors"
              title={p.applicable
                ? (p.description ?? `Apply preset based on ${p.block_def_key}`)
                : `Block_def '${p.block_def_key}' is no longer canvas-validated in this library`}
            >
              <BookmarkSquareIcon className="size-5 text-[var(--gray-a8)]" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-[var(--gray-12)] truncate">{p.name}</div>
                <div className="text-[11px] text-[var(--gray-a8)] truncate font-mono">{p.block_def_key}</div>
              </div>
            </button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDelete(p.id)}
              disabled={disabled}
              aria-label="Delete preset"
              title="Delete preset"
              className="opacity-0 group-hover:opacity-100"
            >
              <TrashIcon className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PaletteSection({
  title, defs, onInsert, disabled,
}: {
  title: string;
  defs: ReadonlyArray<BlockDefSummary>;
  onInsert: (key: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <h4 className="px-1 text-[11px] uppercase tracking-wide text-[var(--gray-a8)]">{title}</h4>
      <ul className="space-y-1">
        {defs.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => onInsert(d.key)}
              disabled={disabled}
              className="w-full flex items-center gap-2 px-2 py-2 rounded-md hover:bg-[var(--gray-a3)] disabled:opacity-50 disabled:cursor-not-allowed text-left transition-colors"
              title={d.description ?? d.name}
            >
              {iconForBlock(d)}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-[var(--gray-12)] truncate">{d.name}</div>
                {d.description && (
                  <div className="text-[11px] text-[var(--gray-a8)] truncate">{d.description}</div>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
