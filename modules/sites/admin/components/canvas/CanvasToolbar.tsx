/**
 * Canvas toolbar — viewport switcher + save status + undo/redo controls.
 * Per spec-sites-wysiwyg-builder §5.2.
 */

import {
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  ComputerDesktopIcon,
  DeviceTabletIcon,
  DevicePhoneMobileIcon,
} from '@heroicons/react/24/outline';
import { Button } from '@/components/ui';

export type Viewport = 'mobile' | 'tablet' | 'desktop';

export const VIEWPORT_WIDTHS: Record<Viewport, string> = {
  mobile: '375px',
  tablet: '768px',
  desktop: '100%',
};

interface CanvasToolbarProps {
  viewport: Viewport;
  onViewportChange: (v: Viewport) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** "Saving…" / "Saved" / null */
  saveStatus: 'saving' | 'saved' | 'error' | null;
  saveError: string | null;
  /** Optional variant picker rendered between viewport and save status. */
  variantPickerSlot?: React.ReactNode;
}

export function CanvasToolbar({
  viewport,
  onViewportChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  saveStatus,
  saveError,
  variantPickerSlot,
}: CanvasToolbarProps) {
  const ic = 'size-4';
  const viewports: Array<{ id: Viewport; label: string; icon: React.ReactNode }> = [
    { id: 'mobile',  label: 'Mobile',  icon: <DevicePhoneMobileIcon className={ic} /> },
    { id: 'tablet',  label: 'Tablet',  icon: <DeviceTabletIcon className={ic} /> },
    { id: 'desktop', label: 'Desktop', icon: <ComputerDesktopIcon className={ic} /> },
  ];

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-[var(--gray-a4)]">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onUndo}
          disabled={!canUndo}
          aria-label="Undo (cmd+z)"
          title="Undo"
        >
          <ArrowUturnLeftIcon className={ic} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRedo}
          disabled={!canRedo}
          aria-label="Redo (cmd+shift+z)"
          title="Redo"
        >
          <ArrowUturnRightIcon className={ic} />
        </Button>
      </div>

      <div className="flex items-center gap-1">
        {viewports.map((v) => (
          <Button
            key={v.id}
            variant={viewport === v.id ? 'soft' : 'ghost'}
            size="sm"
            onClick={() => onViewportChange(v.id)}
            aria-label={v.label}
            title={`Preview at ${v.label.toLowerCase()} width`}
          >
            {v.icon}
          </Button>
        ))}
      </div>

      {variantPickerSlot && (
        <div className="flex items-center">{variantPickerSlot}</div>
      )}

      <div className="flex items-center gap-2 text-xs min-w-[140px] justify-end">
        {saveStatus === 'saving' && (
          <span className="text-[var(--accent-11)]">Saving…</span>
        )}
        {saveStatus === 'saved' && (
          <span className="text-[var(--gray-a8)]">Saved</span>
        )}
        {saveStatus === 'error' && (
          <span className="text-[var(--error-11)]" title={saveError ?? undefined}>Save failed</span>
        )}
      </div>
    </div>
  );
}
