/**
 * Top-level WYSIWYG canvas editor for blocks-mode pages.
 * Per spec-sites-wysiwyg-builder §5.2.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ Toolbar:  [undo] [redo] | [mobile] [tablet] [desktop] | save │
 *   ├──────────────┬──────────────────────────┬───────────────────┤
 *   │              │                          │                   │
 *   │   Block      │   Canvas (iframe srcdoc) │  Properties       │
 *   │   Palette    │   — server-rendered HTML │  Panel (selected) │
 *   │              │   — postMessage <-> us   │                   │
 *   └──────────────┴──────────────────────────┴───────────────────┘
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Card } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { supabase } from '@/lib/supabase';
import { useCanvasLock } from './useCanvasLock.js';
import { useCanvasOps } from './useCanvasOps.js';
import { useFeatureFlags } from './useFeatureFlags.js';
import { CanvasService, type BlockSelection } from './canvas-service.js';
import { Button, Input, Modal } from '@/components/ui';
import { CanvasToolbar, VIEWPORT_WIDTHS, type Viewport } from './CanvasToolbar.js';
import { AddBlockModal } from './AddBlockModal.js';
import { PlusIcon } from '@heroicons/react/24/outline';
import { BlockPalette } from './BlockPalette.js';
import { PropertiesPanel } from './PropertiesPanel.js';
import { VariantPicker } from './VariantPicker.js';
import { UndoStack, deriveInverse, labelForOp } from './undo-stack.js';
import { lookup } from '../../../lib/canvas-render/jsonpath.js';
import type { CanvasOp } from '../../../lib/canvas-render/types.js';

interface SiteCanvasEditorProps {
  pageId: string;
  siteSlug: string;
}

interface SavePresetForm {
  open: boolean;
  name: string;
  description: string;
  saving: boolean;
  error: string | null;
}

interface CanvasMessageFieldChanged {
  type: 'canvas:field-changed';
  blockId: string | null;
  fieldPath: string;
  newValue: string;
}
interface CanvasMessageBlockSelected {
  type: 'canvas:block-selected';
  blockId: string;
}
interface CanvasMessageReady {
  type: 'canvas:ready';
}
type CanvasMessage = CanvasMessageFieldChanged | CanvasMessageBlockSelected | CanvasMessageReady;

function isCanvasMessage(value: unknown): value is CanvasMessage {
  if (!value || typeof value !== 'object') return false;
  const t = (value as { type?: unknown }).type;
  return t === 'canvas:field-changed' || t === 'canvas:block-selected' || t === 'canvas:ready';
}

export function SiteCanvasEditor({ pageId, siteSlug }: SiteCanvasEditorProps) {
  const featureFlags = useFeatureFlags();
  const canvasEnabled = featureFlags.flags?.canvasEnabled ?? true;
  // When the canvas is disabled at the platform, pass null to skip lock
  // acquisition. useCanvasLock stays in 'idle' and we render the disabled
  // banner below — saves a wasted POST that would 503 anyway.
  const lock = useCanvasLock(canvasEnabled ? pageId : null);
  const clientToken = lock.kind === 'held' ? lock.clientToken : null;

  const [initialVersion, setInitialVersion] = useState<number | null>(null);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const { state: ops, submit } = useCanvasOps(pageId, clientToken, initialVersion);

  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [selection, setSelection] = useState<BlockSelection | null>(null);
  const [cohort, setCohort] = useState<ReadonlyArray<{ id: string; sort_order: number }>>([]);
  const undoStackRef = useRef(new UndoStack(100));
  const [stackVersion, setStackVersion] = useState(0); // bumps to trigger toolbar re-render
  const lastEditedFieldsRef = useRef(new Map<string, unknown>()); // for inverse derivation
  const [presetsRefreshKey, setPresetsRefreshKey] = useState(0);
  const [addBlockModalOpen, setAddBlockModalOpen] = useState(false);
  const [savePresetForm, setSavePresetForm] = useState<SavePresetForm>({
    open: false, name: '', description: '', saving: false, error: null,
  });

  // Load page row's version + site's library_id once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pageRes = await supabase
        .from('pages')
        .select('version, site_id')
        .eq('id', pageId)
        .maybeSingle();
      if (cancelled) return;
      const row = pageRes.data as { version: number; site_id: string } | null;
      if (!row) return;
      setInitialVersion(row.version);

      const siteRes = await supabase
        .from('sites')
        .select('templates_library_id')
        .eq('id', row.site_id)
        .maybeSingle();
      if (cancelled) return;
      const siteRow = siteRes.data as { templates_library_id: string | null } | null;
      if (siteRow?.templates_library_id) setLibraryId(siteRow.templates_library_id);
    })();
    return () => { cancelled = true; };
  }, [pageId]);

  // Load selected block details when selection changes.
  const loadSelection = useCallback(async (blockId: string) => {
    const r = await CanvasService.getBlock(blockId);
    if (r.ok) {
      setSelection(r.selection);
      setCohort(r.cohort);
    } else {
      setSelection(null);
      setCohort([]);
    }
  }, []);

  // postMessage listener — only accepts messages from our own origin.
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      if (!isCanvasMessage(ev.data)) return;
      if (ev.data.type === 'canvas:field-changed') {
        const msg = ev.data;
        if (!msg.blockId) return;
        const preValue = lastEditedFieldsRef.current.get(`${msg.blockId}:${msg.fieldPath}`);
        const forward: CanvasOp = {
          kind: 'block.update_field',
          blockId: msg.blockId,
          fieldPath: msg.fieldPath,
          newValue: msg.newValue,
        };
        const inverse = deriveInverse({ forward, preValue });
        undoStackRef.current.push({ forward, inverse, label: labelForOp(forward) });
        setStackVersion((v) => v + 1);
        void submit([forward]);
      } else if (ev.data.type === 'canvas:block-selected') {
        void loadSelection(ev.data.blockId);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [submit, loadSelection]);

  // Capture pre-edit value of fields the user is about to edit. The decorator
  // sends a 'canvas:selection' message when a field becomes contenteditable;
  // we look up the current value on the selected block and stash it.
  useEffect(() => {
    if (!selection) return;
    // Pre-stash all current field values for this block — covers the common
    // case where the user clicks into multiple fields in sequence.
    for (const [path] of Object.entries(selection.content)) {
      const v = lookup(selection.content, path);
      lastEditedFieldsRef.current.set(`${selection.blockId}:${path}`, v);
    }
  }, [selection]);

  // After a successful op, refetch the selection (it may have moved or its
  // sort_order in the cohort changed).
  useEffect(() => {
    if (!selection || ops.submitting) return;
    if (ops.lastError) return;
    void loadSelection(selection.blockId);
    // Intentionally only re-run when ops.version changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops.version]);

  // Surface version-conflict in a hard-reload prompt.
  useEffect(() => {
    if (!ops.versionConflict) return;
    toast.error('Page changed elsewhere — reloading to pick up the latest version.');
    const t = window.setTimeout(() => window.location.reload(), 1500);
    return () => window.clearTimeout(t);
  }, [ops.versionConflict]);

  // Reorder helpers ---------------------------------------------------------
  const cohortIndex = useMemo(() => {
    if (!selection) return -1;
    return cohort.findIndex((b) => b.id === selection.blockId);
  }, [selection, cohort]);
  const canMoveUp = cohortIndex > 0;
  const canMoveDown = cohortIndex >= 0 && cohortIndex < cohort.length - 1;

  const moveBlock = useCallback((direction: 'up' | 'down') => {
    if (!selection) return;
    if (direction === 'up' && cohortIndex <= 0) return;
    if (direction === 'down' && cohortIndex >= cohort.length - 1) return;
    // afterBlockId: when moving up, target is the block before the prior neighbour
    // (so we land before the prior). When moving down, target is the next neighbour.
    const targetIndex = direction === 'up' ? cohortIndex - 2 : cohortIndex + 1;
    const afterBlockId = targetIndex >= 0 ? cohort[targetIndex]?.id ?? null : null;
    const forward: CanvasOp = {
      kind: 'block.move',
      blockId: selection.blockId,
      afterBlockId,
      parentBrickId: selection.parentBrickId,
    };
    undoStackRef.current.push({ forward, inverse: null, label: labelForOp(forward) });
    setStackVersion((v) => v + 1);
    void submit([forward]);
  }, [selection, cohort, cohortIndex, submit]);

  const deleteBlock = useCallback(() => {
    if (!selection) return;
    const forward: CanvasOp = { kind: 'block.delete', blockId: selection.blockId };
    undoStackRef.current.push({ forward, inverse: null, label: labelForOp(forward) });
    setStackVersion((v) => v + 1);
    setSelection(null);
    void submit([forward]);
  }, [selection, submit]);

  const insertBlockAtEnd = useCallback((blockDefKey: string) => {
    // Find the last top-level block to set afterBlockId.
    // We don't have the full block list here; passing afterBlockId=null
    // inserts at the START of the cohort. The server-side
    // _canvas_next_sort_order falls back to MIN-1000 logic. To insert at
    // the END instead, the user can drag-reorder afterwards (Phase 2) or
    // we extend the API with an "insertAtEnd" hint. v1: insert at start;
    // user reorders if they want it elsewhere.
    const forward: CanvasOp = {
      kind: 'block.insert',
      afterBlockId: null,
      parentBrickId: null,
      blockDefKey,
      content: {},
    };
    undoStackRef.current.push({ forward, inverse: null, label: labelForOp(forward) });
    setStackVersion((v) => v + 1);
    void submit([forward]);
  }, [submit]);

  const applyPreset = useCallback((presetId: string) => {
    const forward: CanvasOp = {
      kind: 'preset.apply',
      afterBlockId: null,
      parentBrickId: null,
      presetId,
    };
    undoStackRef.current.push({ forward, inverse: null, label: labelForOp(forward) });
    setStackVersion((v) => v + 1);
    void submit([forward]);
  }, [submit]);

  const openSavePreset = useCallback(() => {
    if (!selection) return;
    setSavePresetForm({
      open: true,
      name: `${selection.blockDefKey} preset`,
      description: '',
      saving: false,
      error: null,
    });
  }, [selection]);

  const submitSavePreset = useCallback(async () => {
    if (!selection) return;
    if (!savePresetForm.name.trim()) {
      setSavePresetForm((s) => ({ ...s, error: 'name required' }));
      return;
    }
    setSavePresetForm((s) => ({ ...s, saving: true, error: null }));
    const r = await CanvasService.savePreset(siteSlug, {
      name: savePresetForm.name.trim(),
      description: savePresetForm.description.trim() || undefined,
      fromBlockId: selection.blockId,
    });
    if (r.ok) {
      toast.success(`Preset "${r.preset.name}" saved`);
      setSavePresetForm({ open: false, name: '', description: '', saving: false, error: null });
      setPresetsRefreshKey((k) => k + 1);
    } else {
      setSavePresetForm((s) => ({ ...s, saving: false, error: r.error.message }));
    }
  }, [selection, savePresetForm.name, savePresetForm.description, siteSlug]);

  const setVariant = useCallback((variantKey: string) => {
    if (!selection) return;
    if (selection.variant_key === variantKey) return;
    const forward: CanvasOp = {
      kind: 'block.set_variant',
      blockId: selection.blockId,
      variantKey,
    };
    const inverse = deriveInverse({ forward, preVariantKey: selection.variant_key });
    undoStackRef.current.push({ forward, inverse, label: labelForOp(forward) });
    setStackVersion((v) => v + 1);
    void submit([forward]);
  }, [selection, submit]);

  const updateSelectedField = useCallback((fieldPath: string, newValue: unknown) => {
    if (!selection) return;
    const preValue = lookup(selection.content, fieldPath);
    const forward: CanvasOp = {
      kind: 'block.update_field',
      blockId: selection.blockId,
      fieldPath,
      newValue,
    };
    const inverse = deriveInverse({ forward, preValue });
    undoStackRef.current.push({ forward, inverse, label: labelForOp(forward) });
    setStackVersion((v) => v + 1);
    void submit([forward]);
  }, [selection, submit]);

  const handleUndo = useCallback(() => {
    const inv = undoStackRef.current.undo();
    setStackVersion((v) => v + 1);
    if (inv) void submit([inv]);
  }, [submit]);

  const handleRedo = useCallback(() => {
    const fwd = undoStackRef.current.redo();
    setStackVersion((v) => v + 1);
    if (fwd) void submit([fwd]);
  }, [submit]);

  // Keyboard shortcuts. Only listen when the canvas is mounted and the
  // active element isn't a typing surface (to avoid stealing cmd+z from
  // the iframe's contenteditable + the properties panel inputs).
  useEffect(() => {
    const handler = (ev: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toUpperCase();
      const inForm = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      const editable = (document.activeElement as HTMLElement | null)?.isContentEditable ?? false;
      const meta = ev.metaKey || ev.ctrlKey;

      // Escape always works — deselects.
      if (ev.key === 'Escape') {
        setSelection(null);
        return;
      }
      // cmd+z / cmd+shift+z — only when not typing into a form input.
      if (inForm || editable) return;
      if (meta && (ev.key === 'z' || ev.key === 'Z')) {
        ev.preventDefault();
        if (ev.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      // cmd+y — alternate redo (Windows convention).
      if (meta && (ev.key === 'y' || ev.key === 'Y')) {
        ev.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleUndo, handleRedo]);

  // Feature-flag gate ------------------------------------------------------
  if (featureFlags.loading) {
    return (
      <Card>
        <div className="p-12 flex flex-col items-center gap-3">
          <LoadingSpinner />
          <p className="text-sm text-[var(--gray-a8)]">Loading editor…</p>
        </div>
      </Card>
    );
  }
  if (!canvasEnabled) {
    return (
      <Card>
        <div className="p-6 space-y-3">
          <h3 className="text-base font-semibold text-[var(--gray-12)]">Canvas editor is disabled</h3>
          <p className="text-sm text-[var(--gray-a8)]">
            The platform administrator has disabled the WYSIWYG canvas. Switch this page to schema mode
            or ask your operator to set <code className="font-mono">CANVAS_ENABLED=true</code>.
          </p>
        </div>
      </Card>
    );
  }

  // Lock state UI ------------------------------------------------------------
  if (lock.kind === 'idle' || lock.kind === 'acquiring') {
    return (
      <Card>
        <div className="p-12 flex flex-col items-center gap-3">
          <LoadingSpinner />
          <p className="text-sm text-[var(--gray-a8)]">Acquiring editor lock…</p>
        </div>
      </Card>
    );
  }

  if (lock.kind === 'conflict') {
    return (
      <Card>
        <div className="p-6 space-y-3">
          <h3 className="text-base font-semibold text-[var(--warning-11)]">Another editor is on this page</h3>
          <p className="text-sm text-[var(--gray-a8)]">
            <span className="font-mono">{lock.activeEditor.id}</span> opened this page at{' '}
            {new Date(lock.lockedAt).toLocaleString()}. Their lock will release after 90 seconds of inactivity;
            this page will retry automatically.
          </p>
        </div>
      </Card>
    );
  }

  if (lock.kind === 'error') {
    return (
      <Card>
        <div className="p-6 space-y-3">
          <h3 className="text-base font-semibold text-[var(--error-11)]">Couldn't open the canvas</h3>
          <p className="text-sm text-[var(--gray-a8)]">{lock.message}</p>
        </div>
      </Card>
    );
  }

  // lock.kind === 'held' beyond this point.
  if (ops.loading || !ops.html) {
    return (
      <Card>
        <div className="p-12 flex flex-col items-center gap-3">
          <LoadingSpinner />
          <p className="text-sm text-[var(--gray-a8)]">Loading canvas…</p>
        </div>
      </Card>
    );
  }

  const saveStatus: 'saving' | 'saved' | 'error' | null =
    ops.submitting ? 'saving'
    : ops.lastError && !ops.versionConflict ? 'error'
    : ops.version !== null ? 'saved'
    : null;

  // Reference stackVersion to ensure toolbar re-renders when stack changes.
  void stackVersion;

  return (
    <div className="space-y-3">
      {libraryId && (
        <AddBlockModal
          isOpen={addBlockModalOpen}
          onClose={() => setAddBlockModalOpen(false)}
          libraryId={libraryId}
          onInsert={insertBlockAtEnd}
          disabled={ops.submitting}
        />
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setAddBlockModalOpen(true)}
          disabled={!libraryId || ops.submitting}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-[var(--accent-9)] text-white text-sm font-medium hover:bg-[var(--accent-10)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
        >
          <PlusIcon className="size-4" />
          Add Block
        </button>
      </div>
      <Card>
        <CanvasToolbar
          viewport={viewport}
          onViewportChange={setViewport}
          canUndo={undoStackRef.current.canUndo()}
          canRedo={undoStackRef.current.canRedo()}
          onUndo={handleUndo}
          onRedo={handleRedo}
          saveStatus={saveStatus}
          saveError={ops.lastError}
          variantPickerSlot={
            selection?.abTest ? (
              <VariantPicker
                abTest={selection.abTest}
                currentVariant={selection.variant_key}
                onChange={setVariant}
                disabled={ops.submitting}
              />
            ) : null
          }
        />
      </Card>

      <div className="grid grid-cols-[260px_1fr_300px] gap-3 min-h-[600px]">
        {libraryId ? (
          <BlockPalette
            libraryId={libraryId}
            siteSlug={siteSlug}
            onInsert={insertBlockAtEnd}
            onApplyPreset={applyPreset}
            presetsRefreshKey={presetsRefreshKey}
            disabled={ops.submitting}
          />
        ) : (
          <Card>
            <div className="p-3">
              <h3 className="text-sm font-semibold text-[var(--gray-12)]">Blocks</h3>
              <p className="mt-2 text-xs text-[var(--gray-a8)]">No library bound to this site.</p>
            </div>
          </Card>
        )}

        <Card>
          <div className="relative" style={{ maxWidth: VIEWPORT_WIDTHS[viewport], margin: viewport === 'desktop' ? '0' : '0 auto' }}>
            <iframe
              title="Canvas preview"
              sandbox="allow-same-origin allow-scripts"
              srcDoc={ops.html}
              className="w-full min-h-[600px] border-0 rounded-lg bg-white"
              style={{ width: VIEWPORT_WIDTHS[viewport] }}
            />
            {(!ops.html || ops.html.replace(/\s/g, '').length === 0) && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="max-w-sm text-center px-4 py-3 rounded-md bg-[var(--gray-a2)]/95 border border-dashed border-[var(--gray-a5)] pointer-events-auto">
                  <p className="text-sm font-medium text-[var(--gray-12)]">No blocks yet</p>
                  <p className="mt-1 text-xs text-[var(--gray-a9)]">
                    Add blocks from the palette on the left. If the palette is empty, connect a theme git
                    repo via the Source tab (e.g. <span className="font-mono">gatewaze-template-site</span>) to
                    populate this site's block library.
                  </p>
                </div>
              </div>
            )}
          </div>
        </Card>

        <PropertiesPanel
          selection={selection}
          onUpdateField={updateSelectedField}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
          onMoveUp={() => moveBlock('up')}
          onMoveDown={() => moveBlock('down')}
          onDelete={deleteBlock}
          onSaveAsPreset={openSavePreset}
          disabled={ops.submitting}
        />
      </div>

      {/* Save as preset modal */}
      <Modal
        isOpen={savePresetForm.open}
        onClose={() => setSavePresetForm((s) => ({ ...s, open: false }))}
        title="Save block as preset"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="outlined"
              onClick={() => setSavePresetForm((s) => ({ ...s, open: false }))}
              disabled={savePresetForm.saving}
            >
              Cancel
            </Button>
            <Button onClick={submitSavePreset} disabled={savePresetForm.saving}>
              {savePresetForm.saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Input
            label="Name"
            placeholder="e.g. Hero with CTA"
            value={savePresetForm.name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setSavePresetForm((s) => ({ ...s, name: e.target.value, error: null }))
            }
          />
          <Input
            label="Description (optional)"
            placeholder="Notes for future operators"
            value={savePresetForm.description}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setSavePresetForm((s) => ({ ...s, description: e.target.value }))
            }
          />
          {savePresetForm.error && (
            <p className="text-sm text-[var(--error-11)]">{savePresetForm.error}</p>
          )}
          <p className="text-xs text-[var(--gray-a8)]">
            Snapshots the current block + any nested bricks (and their content) into a reusable
            preset for this site.
          </p>
        </div>
      </Modal>
    </div>
  );
}
