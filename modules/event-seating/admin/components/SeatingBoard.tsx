import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui';
import {
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import {
  createTable,
  clearTableSeats,
  deleteTable as deleteTableRow,
  getAssets,
  getAssignments,
  getGuests,
  getTables,
  seatOccupant,
  unseat as unseatRow,
  updatePlan,
  updateTable,
  uploadBackground,
  type Guest,
  type SeatingAsset,
  type SeatingAssignment,
  type SeatingPlan,
  type SeatingTable,
} from '../utils/seatingService';
import { maxSeatsFor, minSeatSpacing, usableSeatCount, MIN_SEAT_SPACING } from '../utils/seatGeometry';
import { isDeleteTableShortcut } from '../utils/deleteShortcut';
import { takeSnapshot, restoreSnapshot } from '../utils/planSnapshot';
import {
  EMPTY_UNDO, canRedo, canUndo, recordChange, redo as redoStep, redoLabel,
  undo as undoStep, undoLabel, undoShortcut, type UndoState,
} from '../utils/undoStack';
import { TABLE_PRESETS } from '../utils/tablePresets';
import { useBackgroundImage } from '../utils/useBackgroundImage';
import {
  downloadCanvasAsPdf,
  downloadCanvasAsPng,
  planFilename,
  renderPlanToCanvas,
} from '../utils/exportPlan';
import { SeatingCanvas, type DragState } from './SeatingCanvas';
import { CateringPdfModal } from './CateringPdfModal';
import { GuestTray } from './GuestTray';
import { TableInspector } from './TableInspector';

interface Props {
  plan: SeatingPlan;
  eventUuid: string;
  subEventName: string;
  onPlanChange: (plan: SeatingPlan) => void;
}

/** Mac reads Cmd, everything else Ctrl — only affects what the tooltip says. */
const modifierLabel =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
    ? '\u2318'
    : 'Ctrl+';

export function SeatingBoard({ plan, eventUuid, subEventName, onPlanChange }: Props) {
  const [tables, setTables] = useState<SeatingTable[]>([]);
  const [assignments, setAssignments] = useState<SeatingAssignment[]>([]);
  const [guests, setGuests] = useState<Guest[]>([]);
  const [assets, setAssets] = useState<SeatingAsset[]>([]);
  const [selectedTableIds, setSelectedTableIds] = useState<string[]>([]);
  const [drag, setDrag] = useState<DragState>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [cateringOpen, setCateringOpen] = useState(false);
  const [undoState, setUndoState] = useState<UndoState>(EMPTY_UNDO);
  const [restoring, setRestoring] = useState(false);

  // The live plan, read at the moment an edit happens. A ref rather than the
  // state values so `record` never captures a stale closure mid-drag.
  const liveRef = useRef({ tables: [] as SeatingTable[], assignments: [] as SeatingAssignment[] });
  liveRef.current = { tables, assignments };

  /**
   * Remember the plan as it stands, before an edit changes it. Called at the
   * top of every mutating handler; `coalesceKey` collapses a burst — dragging,
   * or typing in a field — into one undo step.
   */
  const record = useCallback((label: string, coalesceKey?: string) => {
    const snapshot = takeSnapshot(liveRef.current.tables, liveRef.current.assignments);
    setUndoState((prev) => recordChange(prev, { label, snapshot, coalesceKey, at: Date.now() }));
  }, []);

  // Table geometry edits fire on every keystroke and every drag frame; the
  // canvas updates from local state and the database catches up on a debounce.
  const pendingTableWrites = useRef(new Map<string, Partial<SeatingTable>>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const backgroundAsset = useMemo(
    () => assets.find((a) => a.id === plan.background_asset_id) || null,
    [assets, plan.background_asset_id],
  );
  const { image: backgroundImage, dataUrl: backgroundUrl } = useBackgroundImage(backgroundAsset);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tableRows, assignmentRows, guestRows, assetRows] = await Promise.all([
        getTables(plan.id),
        getAssignments(plan.id),
        getGuests(eventUuid, plan.sub_event_id, plan.guest_statuses),
        getAssets(eventUuid),
      ]);
      setTables(tableRows);
      setAssignments(assignmentRows);
      setGuests(guestRows);
      setAssets(assetRows);
    } catch (err) {
      console.error('[event-seating] Failed to load the plan:', err);
      toast.error('Could not load this seating plan');
    } finally {
      setLoading(false);
    }
  }, [plan.id, plan.sub_event_id, plan.guest_statuses, eventUuid]);

  useEffect(() => { load(); }, [load]);

  /**
   * Step the history. The live plan becomes the entry on the opposite stack,
   * so undo and redo are the same move in either direction.
   */
  const step = useCallback(async (direction: 'undo' | 'redo') => {
    if (restoring) return;
    const current = takeSnapshot(liveRef.current.tables, liveRef.current.assignments);
    const result = direction === 'undo'
      ? undoStep(undoState, current)
      : redoStep(undoState, current);
    if (!result) return;

    setRestoring(true);
    // Show the restored plan immediately; the database catches up behind it.
    setTables(result.restore.tables);
    setAssignments(result.restore.assignments);
    setSelectedTableIds((ids) =>
      ids.filter((id) => result.restore.tables.some((t) => t.id === id)));
    setUndoState(result.state);

    try {
      await restoreSnapshot(plan.id, result.restore);
      toast.success(`${direction === 'undo' ? 'Undid' : 'Redid'} ${result.label}`);
    } catch (err) {
      console.error(`[event-seating] Failed to ${direction}:`, err);
      toast.error(`Could not ${direction} that`);
      // The optimistic state is now a guess; go back to what the server holds.
      load();
    } finally {
      setRestoring(false);
    }
  }, [restoring, undoState, plan.id, load]);

  // ---- derived lookups ---------------------------------------------------

  const guestsById = useMemo(() => {
    const map = new Map<string, Guest>();
    for (const g of guests) map.set(g.id, g);
    return map;
  }, [guests]);

  const namesByAssignment = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of assignments) {
      if (a.party_member_id) {
        map.set(a.id, guestsById.get(a.party_member_id)?.full_name || 'Guest (not in list)');
      } else if (a.guest_label) {
        map.set(a.id, a.guest_label);
      }
    }
    return map;
  }, [assignments, guestsById]);

  const seatedMemberIds = useMemo(() => {
    const set = new Set<string>();
    for (const a of assignments) if (a.party_member_id) set.add(a.party_member_id);
    return set;
  }, [assignments]);

  const selectedTableId = selectedTableIds.length === 1 ? selectedTableIds[0] : null;
  const selectedTable = tables.find((t) => t.id === selectedTableId) || null;
  const selectedTables = tables.filter((t) => selectedTableIds.includes(t.id));
  const seatTotal = tables.reduce((sum, t) => sum + t.seat_count, 0);

  // ---- table writes ------------------------------------------------------

  const flushTableWrites = useCallback(async () => {
    const pending = pendingTableWrites.current;
    if (pending.size === 0) return;
    const entries = [...pending.entries()];
    pending.clear();
    try {
      await Promise.all(entries.map(([id, patch]) => updateTable(id, patch)));
    } catch (err) {
      console.error('[event-seating] Failed to save table changes:', err);
      toast.error('Could not save the table change');
      load();
    }
  }, [load]);

  const queueTableWrite = useCallback((id: string, patch: Partial<SeatingTable>, immediate = false) => {
    const pending = pendingTableWrites.current;
    pending.set(id, { ...(pending.get(id) || {}), ...patch });
    if (flushTimer.current) clearTimeout(flushTimer.current);
    if (immediate) {
      flushTableWrites();
    } else {
      flushTimer.current = setTimeout(() => { flushTableWrites(); }, 600);
    }
  }, [flushTableWrites]);

  // Never leave an edit unsaved on unmount.
  useEffect(() => () => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTableWrites();
  }, [flushTableWrites]);

  const patchTableLocal = useCallback((id: string, patch: Partial<SeatingTable>) => {
    setTables((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const draggingRef = useRef(false);

  const handleMoveTables = useCallback(
    (moves: Array<{ id: string; x: number; y: number }>, commit: boolean) => {
      // The first frame of a drag is the moment to remember where things were;
      // recording per frame would fill the history with one step per pixel.
      if (!draggingRef.current) {
        draggingRef.current = true;
        record(moves.length > 1 ? `move ${moves.length} tables` : 'move table');
      }
      if (commit) draggingRef.current = false;

      // One state update for the whole group, so a group drag doesn't
      // re-render once per table per frame.
      setTables((prev) => {
        const byId = new Map(moves.map((m) => [m.id, m]));
        return prev.map((t) => {
          const move = byId.get(t.id);
          return move ? { ...t, x: move.x, y: move.y } : t;
        });
      });
      if (commit) {
        for (const move of moves) queueTableWrite(move.id, { x: move.x, y: move.y }, true);
      }
    },
    [queueTableWrite, record],
  );

  const handleTablePatch = useCallback((patch: Partial<SeatingTable>) => {
    if (!selectedTableId) return;
    const table = tables.find((t) => t.id === selectedTableId);
    const next = { ...patch };

    if (table) {
      const proposed = { ...table, ...next };

      // Every guest needs MIN_SEAT_SPACING of table to themselves. Adding
      // seats past what the table's size supports is refused rather than
      // silently drawn on top of itself.
      if (typeof next.seat_count === 'number' && next.seat_count > table.seat_count) {
        const capacity = maxSeatsFor({ ...proposed, seat_count: 0 });
        if (next.seat_count > capacity) {
          toast.error(
            `A ${Math.round(proposed.width)}cm table seats ${capacity} at ${MIN_SEAT_SPACING}cm each. Make it bigger to fit more.`,
          );
          return;
        }
      }

      // Shrinking the table is the same rule from the other direction. Refuse
      // rather than quietly dropping seats, which could unseat a guest.
      const resizing = typeof next.width === 'number' || typeof next.height === 'number'
        || typeof next.seat_layout === 'string' || typeof next.shape === 'string';
      if (resizing && proposed.seat_count > 1
          && minSeatSpacing(proposed) < MIN_SEAT_SPACING - 0.5) {
        toast.error(
          `That leaves under ${MIN_SEAT_SPACING}cm per guest for ${proposed.seat_count} seats. Reduce the seats first.`,
        );
        return;
      }

      // Shrinking the seat count can strand blocked indices past the last
      // seat, which would then reappear if it were grown again.
      if (typeof next.seat_count === 'number') {
        const pruned = table.disabled_seats.filter((i) => i < next.seat_count!);
        if (pruned.length !== table.disabled_seats.length) next.disabled_seats = pruned;
      }
    }

    // One undo step per burst of edits to the same field.
    record('table change', `patch:${selectedTableId}:${Object.keys(next).join(',')}`);
    patchTableLocal(selectedTableId, next);
    queueTableWrite(selectedTableId, next);
  }, [selectedTableId, tables, patchTableLocal, queueTableWrite, record]);

  const handleAddTable = useCallback(async (presetId: string) => {
    const preset = TABLE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    record('add table');
    try {
      const created = await createTable(plan.id, {
        ...preset.build(tables.length + 1),
        // Stagger new tables so they don't stack on top of each other.
        x: 220 + (tables.length % 4) * 260,
        y: 200 + Math.floor(tables.length / 4) * 260,
        sort_order: tables.length,
      });
      setTables((prev) => [...prev, created]);
      setSelectedTableIds([created.id]);
    } catch (err) {
      console.error('[event-seating] Failed to add a table:', err);
      toast.error('Could not add the table');
    }
  }, [plan.id, tables]);

  const handleDeleteTable = useCallback(async () => {
    if (selectedTables.length === 0) return;
    const ids = selectedTables.map((t) => t.id);

    // Confirm in proportion to what is lost: empty tables can go without
    // ceremony, ones with guests in them displace people.
    const seated = assignments.filter((a) => ids.includes(a.table_id)).length;
    const what = selectedTables.length === 1
      ? selectedTables[0].label
      : `${selectedTables.length} tables`;
    if (seated > 0) {
      const message =
        `Delete ${what}? ${seated} guest${seated === 1 ? '' : 's'} will go back to the guest list.`;
      if (!window.confirm(message)) return;
    }

    record(selectedTables.length === 1 ? 'delete table' : `delete ${selectedTables.length} tables`);
    try {
      await Promise.all(ids.map((id) => deleteTableRow(id)));
      setTables((prev) => prev.filter((t) => !ids.includes(t.id)));
      setAssignments((prev) => prev.filter((a) => !ids.includes(a.table_id)));
      setSelectedTableIds([]);
    } catch (err) {
      console.error('[event-seating] Failed to delete the table:', err);
      toast.error(selectedTables.length === 1 ? 'Could not delete the table' : 'Could not delete those tables');
      load();
    }
  }, [selectedTables, assignments, load]);

  /**
   * Take a seat in or out of use. Blocking a seat someone is sitting in
   * returns them to the guest list first — the alternative is a guest who
   * exists in the data but appears nowhere on the plan.
   */
  const handleToggleSeat = useCallback(async (tableId: string, seatIndex: number, blocked: boolean) => {
    const table = tables.find((t) => t.id === tableId);
    if (!table) return;

    record(blocked ? 'take a seat out of use' : 'bring a seat back');

    const next = blocked
      ? [...new Set([...table.disabled_seats, seatIndex])].sort((a, b) => a - b)
      : table.disabled_seats.filter((i) => i !== seatIndex);

    const occupant = blocked
      ? assignments.find((a) => a.table_id === tableId && a.seat_index === seatIndex)
      : undefined;

    patchTableLocal(tableId, { disabled_seats: next });
    if (occupant) setAssignments((prev) => prev.filter((a) => a.id !== occupant.id));

    try {
      // Unseat before blocking: the database rejects an assignment in a
      // blocked seat, so the order matters.
      if (occupant) await unseatRow(occupant.id);
      await updateTable(tableId, { disabled_seats: next });
      if (occupant) {
        const name = namesByAssignment.get(occupant.id) || 'That guest';
        toast.info(`${name} went back to the guest list`);
      }
    } catch (err) {
      console.error('[event-seating] Failed to change the seat:', err);
      toast.error('Could not change that seat');
      load();
    }
  }, [tables, assignments, patchTableLocal, namesByAssignment, load, record]);

  const handleClearSeats = useCallback(async () => {
    if (!selectedTable) return;
    record('clear the table');
    try {
      await clearTableSeats(selectedTable.id);
      setAssignments((prev) => prev.filter((a) => a.table_id !== selectedTable.id));
    } catch (err) {
      console.error('[event-seating] Failed to clear the table:', err);
      toast.error('Could not clear the table');
    }
  }, [selectedTable, record]);

  // ---- guest placement ---------------------------------------------------

  const startGuestDrag = useCallback((guest: Guest, clientX: number, clientY: number) => {
    setDrag({
      kind: 'guest',
      label: guest.full_name,
      partyMemberId: guest.id,
      assignmentId: null,
      clientX,
      clientY,
      target: null,
    });
  }, []);

  const startCustomGuestDrag = useCallback((label: string) => {
    setDrag({
      kind: 'guest',
      label,
      partyMemberId: null,
      assignmentId: null,
      clientX: window.innerWidth / 2,
      clientY: window.innerHeight / 2,
      target: null,
    });
    toast.info(`Click a seat to place ${label}`);
  }, []);

  const handleDropGuest = useCallback(async (target: { tableId: string; seatIndex: number } | null) => {
    const current = drag;
    setDrag(null);
    if (!current || current.kind !== 'guest') return;

    // Dropped away from any seat: a seated guest goes back to the list, a
    // tray guest simply stays there.
    if (!target) {
      if (!current.assignmentId) return;
      record('return a guest to the list');
      try {
        await unseatRow(current.assignmentId);
        setAssignments((prev) => prev.filter((a) => a.id !== current.assignmentId));
      } catch (err) {
        console.error('[event-seating] Failed to unseat the guest:', err);
        toast.error('Could not move that guest');
        load();
      }
      return;
    }

    record('seat a guest');
    try {
      await seatOccupant({
        planId: plan.id,
        tableId: target.tableId,
        seatIndex: target.seatIndex,
        movingAssignmentId: current.assignmentId,
        partyMemberId: current.partyMemberId,
        guestLabel: current.partyMemberId ? null : current.label,
      });
      // Seating can cascade (a swap rewrites two rows), so resettle on
      // whatever the database now holds rather than patching state by hand.
      setAssignments(await getAssignments(plan.id));
    } catch (err) {
      console.error('[event-seating] Failed to seat the guest:', err);
      toast.error('Could not seat that guest');
      load();
    }
  }, [drag, plan.id, load, record]);

  const handleUnseat = useCallback(async (assignmentId: string) => {
    record('return a guest to the list');
    try {
      await unseatRow(assignmentId);
      setAssignments((prev) => prev.filter((a) => a.id !== assignmentId));
    } catch (err) {
      console.error('[event-seating] Failed to unseat the guest:', err);
      toast.error('Could not remove that guest from their seat');
    }
  }, [record]);

  /**
   * Backspace or Delete removes the selected table. Whether a given keypress
   * counts is decided by isDeleteTableShortcut, which keeps the shortcut from
   * eating typing in the board's many text fields; preventDefault stops the
   * browser treating a stray Backspace as "go back".
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isDeleteTableShortcut(e, {
        dragging: drag !== null,
        dialogOpen: cateringOpen,
        hasSelection: selectedTableIds.length > 0,
      })) return;
      e.preventDefault();
      handleDeleteTable();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedTableIds, drag, cateringOpen, handleDeleteTable]);

  // Ctrl/Cmd+Z steps back, Ctrl/Cmd+Shift+Z (or Ctrl+Y) forward. Text fields
  // keep their own undo — see undoShortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (cateringOpen || drag) return;
      const action = undoShortcut(e);
      if (!action) return;
      e.preventDefault();
      step(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, cateringOpen, drag]);

  // Escape cancels a pick-up mid-drag.
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrag(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag]);

  // ---- plan settings -----------------------------------------------------

  const patchPlan = useCallback(async (patch: Partial<SeatingPlan>) => {
    const next = { ...plan, ...patch };
    onPlanChange(next);
    try {
      await updatePlan(plan.id, patch);
    } catch (err) {
      console.error('[event-seating] Failed to save the plan:', err);
      toast.error('Could not save that change');
      onPlanChange(plan);
    }
  }, [plan, onPlanChange]);

  const handleUploadBackground = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const asset = await uploadBackground(eventUuid, file);
      setAssets((prev) => [asset, ...prev]);
      await patchPlan({ background_asset_id: asset.id });
      toast.success('Floor plan added');
    } catch (err) {
      console.error('[event-seating] Failed to upload the floor plan:', err);
      toast.error(err instanceof Error ? err.message : 'Could not upload that floor plan');
    } finally {
      setUploading(false);
    }
  }, [eventUuid, patchPlan]);

  // ---- export ------------------------------------------------------------

  const runExport = useCallback(async (format: 'png' | 'pdf') => {
    setExporting(true);
    try {
      const canvas = renderPlanToCanvas({
        plan,
        tables,
        assignments,
        namesByAssignment,
        background: backgroundImage,
        title: subEventName ? `${plan.name} — ${subEventName}` : plan.name,
      });
      if (format === 'png') downloadCanvasAsPng(canvas, planFilename(plan.name, 'png'));
      else await downloadCanvasAsPdf(canvas, planFilename(plan.name, 'pdf'));
    } catch (err) {
      console.error('[event-seating] Export failed:', err);
      toast.error('Could not export the plan');
    } finally {
      setExporting(false);
    }
  }, [plan, tables, assignments, namesByAssignment, backgroundImage, subEventName]);

  // ---- render ------------------------------------------------------------

  if (loading) {
    return <div className="py-10 text-center text-sm text-[var(--gray-9)]">Loading seating plan…</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* A native select keeps every preset in one control without a custom
            popover, and groups them the way people describe tables. */}
        <select
          value=""
          onChange={(e) => { if (e.target.value) handleAddTable(e.target.value); }}
          className="rounded-md border border-[var(--gray-6)] bg-[var(--color-background)] px-2 py-1 text-xs text-[var(--gray-12)]"
        >
          <option value="">+ Add a table…</option>
          {['Rectangular — guests opposite', 'Round', 'Top table'].map((group) => (
            <optgroup key={group} label={group}>
              {TABLE_PRESETS.filter((p) => p.group === group).map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </optgroup>
          ))}
        </select>

        <label className="cursor-pointer">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,application/pdf"
            onChange={handleUploadBackground}
            className="hidden"
          />
          <span className="inline-flex items-center gap-1 rounded-md border border-[var(--gray-6)] px-2 py-1 text-xs text-[var(--gray-11)] hover:border-[var(--accent-8)]">
            <ArrowUpTrayIcon className="h-3 w-3" />
            {uploading ? 'Uploading…' : backgroundAsset ? 'Replace floor plan' : 'Floor plan'}
          </span>
        </label>

        {backgroundAsset && (
          <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-[var(--gray-11)]">
            <input
              type="checkbox"
              checked={!plan.background_hidden}
              onChange={(e) => patchPlan({ background_hidden: !e.target.checked })}
              className="cursor-pointer"
            />
            Show floor plan
          </label>
        )}

        {/* Tables are drawn at real size, so the room has to be the real room
            or nothing lines up. Metres here, centimetres in the database. */}
        <label className="flex items-center gap-1 text-xs text-[var(--gray-11)]">
          Room
          <input
            type="number"
            min={2}
            max={200}
            step={0.5}
            value={plan.canvas_width / 100}
            onChange={(e) => {
              const m = parseFloat(e.target.value);
              if (Number.isFinite(m) && m >= 2) patchPlan({ canvas_width: Math.round(m * 100) });
            }}
            className="w-14 rounded border border-[var(--gray-6)] bg-[var(--color-background)] px-1 py-0.5 text-xs text-[var(--gray-12)]"
          />
          ×
          <input
            type="number"
            min={2}
            max={200}
            step={0.5}
            value={plan.canvas_height / 100}
            onChange={(e) => {
              const m = parseFloat(e.target.value);
              if (Number.isFinite(m) && m >= 2) patchPlan({ canvas_height: Math.round(m * 100) });
            }}
            className="w-14 rounded border border-[var(--gray-6)] bg-[var(--color-background)] px-1 py-0.5 text-xs text-[var(--gray-12)]"
          />
          m
        </label>

        <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-[var(--gray-11)]">
          <input
            type="checkbox"
            checked={plan.snap_to_grid}
            onChange={(e) => patchPlan({ snap_to_grid: e.target.checked })}
            className="cursor-pointer"
          />
          <span title="Lines tables up with each other's edges and centres, and falls back to the grid">
            Snap
          </span>
        </label>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-0.5">
            <Button
              variant="soft"
              size="1"
              disabled={!canUndo(undoState) || restoring}
              title={canUndo(undoState) ? `Undo ${undoLabel(undoState)} (${modifierLabel}Z)` : 'Nothing to undo'}
              onClick={() => step('undo')}
            >
              <ArrowUturnLeftIcon className="h-3 w-3" />
            </Button>
            <Button
              variant="soft"
              size="1"
              disabled={!canRedo(undoState) || restoring}
              title={canRedo(undoState) ? `Redo ${redoLabel(undoState)} (${modifierLabel}\u21e7Z)` : 'Nothing to redo'}
              onClick={() => step('redo')}
            >
              <ArrowUturnRightIcon className="h-3 w-3" />
            </Button>
          </div>
          <span className="text-xs text-[var(--gray-9)]">
            {assignments.length}/{seatTotal} seats filled · {guests.length - seatedMemberIds.size} to place
          </span>
          <Button variant="soft" size="1" disabled={exporting} onClick={() => runExport('png')}>
            <ArrowDownTrayIcon className="mr-0.5 h-3 w-3" />PNG
          </Button>
          <Button variant="soft" size="1" disabled={exporting} onClick={() => runExport('pdf')}>
            <ArrowDownTrayIcon className="mr-0.5 h-3 w-3" />PDF
          </Button>
          <Button variant="soft" size="1" onClick={() => setCateringOpen(true)}>
            <ArrowDownTrayIcon className="mr-0.5 h-3 w-3" />Meal sheets
          </Button>
        </div>
      </div>

      {/* Board */}
      <div className="flex gap-3">
        <div className="w-56 flex-shrink-0">
          {/* Releasing a seated guest anywhere off a seat — including over this
              list — returns them to it; the canvas resolves that on pointerup. */}
          <div className="h-[640px] rounded-lg border border-[var(--gray-6)] p-2">
            <GuestTray
              guests={guests}
              seatedMemberIds={seatedMemberIds}
              onStartDrag={startGuestDrag}
              onAddCustomGuest={startCustomGuestDrag}
              activeMemberId={drag?.kind === 'guest' ? drag.partyMemberId : null}
            />
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <SeatingCanvas
            plan={plan}
            tables={tables}
            assignments={assignments}
            namesByAssignment={namesByAssignment}
            backgroundUrl={backgroundUrl}
            selectedTableIds={selectedTableIds}
            drag={drag}
            onDragChange={setDrag}
            onSelectTables={setSelectedTableIds}
            onMoveTables={handleMoveTables}
            onDropGuest={handleDropGuest}
            onSeatContextMenu={handleUnseat}
            onBlockSeat={(tableId, seatIndex) => handleToggleSeat(tableId, seatIndex, true)}
          />
          <p className="mt-1 text-[11px] text-[var(--gray-9)]">
            Drag a table to move it. Drag a name from the list onto a seat, or drag a seated guest to
            another seat to swap them. Right-click a seat to empty it. Select a table and
            press Backspace to delete it. Dragging a table lines it up with its neighbours'
            edges and centres. Drag across empty space to select several tables and move
            them together; shift-click to add one to the selection.
          </p>
        </div>

        <div className="w-60 flex-shrink-0 overflow-y-auto rounded-lg border border-[var(--gray-6)] p-2">
          {selectedTables.length > 1 ? (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-[var(--gray-12)]">
                {selectedTables.length} tables selected
              </h4>
              <p className="text-[11px] text-[var(--gray-11)]">
                Drag any one of them to move the group. Shift-click a table to add or
                remove it. Backspace deletes them all.
              </p>
              <ul className="space-y-0.5 text-[11px] text-[var(--gray-11)]">
                {selectedTables.map((t) => {
                  const seated = assignments.filter((a) => a.table_id === t.id).length;
                  return (
                    <li key={t.id} className="flex justify-between gap-2">
                      <span className="truncate">{t.label}</span>
                      <span className="flex-shrink-0 text-[var(--gray-9)]">
                        {seated}/{usableSeatCount(t)}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <Button variant="soft" size="1" color="red" onClick={handleDeleteTable}>
                Delete {selectedTables.length} tables
              </Button>
            </div>
          ) : (
          <TableInspector
            table={selectedTable}
            assignments={assignments}
            namesByAssignment={namesByAssignment}
            onChange={handleTablePatch}
            onDelete={handleDeleteTable}
            onClearSeats={handleClearSeats}
            onUnseat={handleUnseat}
            onToggleSeat={(seatIndex, blocked) =>
              selectedTableId && handleToggleSeat(selectedTableId, seatIndex, blocked)}
          />
          )}
        </div>
      </div>

      <CateringPdfModal
        isOpen={cateringOpen}
        onClose={() => setCateringOpen(false)}
        plan={plan}
        tables={tables}
        assignments={assignments}
        guests={guests}
        documentTitle={plan.name}
        subtitle={subEventName || 'All guests'}
      />
    </div>
  );
}

export default SeatingBoard;
