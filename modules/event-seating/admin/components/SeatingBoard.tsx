import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui';
import {
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
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

export function SeatingBoard({ plan, eventUuid, subEventName, onPlanChange }: Props) {
  const [tables, setTables] = useState<SeatingTable[]>([]);
  const [assignments, setAssignments] = useState<SeatingAssignment[]>([]);
  const [guests, setGuests] = useState<Guest[]>([]);
  const [assets, setAssets] = useState<SeatingAsset[]>([]);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [cateringOpen, setCateringOpen] = useState(false);

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

  const selectedTable = tables.find((t) => t.id === selectedTableId) || null;
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

  const handleMoveTable = useCallback((tableId: string, x: number, y: number, commit: boolean) => {
    patchTableLocal(tableId, { x, y });
    if (commit) queueTableWrite(tableId, { x, y }, true);
  }, [patchTableLocal, queueTableWrite]);

  const handleTablePatch = useCallback((patch: Partial<SeatingTable>) => {
    if (!selectedTableId) return;
    const table = tables.find((t) => t.id === selectedTableId);
    const next = { ...patch };
    // Shrinking a table can strand blocked indices past the last seat, which
    // would then reappear if it were grown again. Drop them as we go.
    if (table && typeof next.seat_count === 'number') {
      const pruned = table.disabled_seats.filter((i) => i < next.seat_count!);
      if (pruned.length !== table.disabled_seats.length) next.disabled_seats = pruned;
    }
    patchTableLocal(selectedTableId, next);
    queueTableWrite(selectedTableId, next);
  }, [selectedTableId, tables, patchTableLocal, queueTableWrite]);

  const handleAddTable = useCallback(async (presetId: string) => {
    const preset = TABLE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    try {
      const created = await createTable(plan.id, {
        ...preset.build(tables.length + 1),
        // Stagger new tables so they don't stack on top of each other.
        x: 220 + (tables.length % 4) * 260,
        y: 200 + Math.floor(tables.length / 4) * 260,
        sort_order: tables.length,
      });
      setTables((prev) => [...prev, created]);
      setSelectedTableId(created.id);
    } catch (err) {
      console.error('[event-seating] Failed to add a table:', err);
      toast.error('Could not add the table');
    }
  }, [plan.id, tables]);

  const handleDeleteTable = useCallback(async () => {
    if (!selectedTable) return;
    const seated = assignments.filter((a) => a.table_id === selectedTable.id).length;
    const message = seated > 0
      ? `Delete ${selectedTable.label}? ${seated} guest${seated === 1 ? '' : 's'} will go back to the guest list.`
      : `Delete ${selectedTable.label}?`;
    if (!window.confirm(message)) return;
    try {
      await deleteTableRow(selectedTable.id);
      setTables((prev) => prev.filter((t) => t.id !== selectedTable.id));
      setAssignments((prev) => prev.filter((a) => a.table_id !== selectedTable.id));
      setSelectedTableId(null);
    } catch (err) {
      console.error('[event-seating] Failed to delete the table:', err);
      toast.error('Could not delete the table');
    }
  }, [selectedTable, assignments]);

  /**
   * Take a seat in or out of use. Blocking a seat someone is sitting in
   * returns them to the guest list first — the alternative is a guest who
   * exists in the data but appears nowhere on the plan.
   */
  const handleToggleSeat = useCallback(async (tableId: string, seatIndex: number, blocked: boolean) => {
    const table = tables.find((t) => t.id === tableId);
    if (!table) return;

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
  }, [tables, assignments, patchTableLocal, namesByAssignment, load]);

  const handleClearSeats = useCallback(async () => {
    if (!selectedTable) return;
    try {
      await clearTableSeats(selectedTable.id);
      setAssignments((prev) => prev.filter((a) => a.table_id !== selectedTable.id));
    } catch (err) {
      console.error('[event-seating] Failed to clear the table:', err);
      toast.error('Could not clear the table');
    }
  }, [selectedTable]);

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
  }, [drag, plan.id, load]);

  const handleUnseat = useCallback(async (assignmentId: string) => {
    try {
      await unseatRow(assignmentId);
      setAssignments((prev) => prev.filter((a) => a.id !== assignmentId));
    } catch (err) {
      console.error('[event-seating] Failed to unseat the guest:', err);
      toast.error('Could not remove that guest from their seat');
    }
  }, []);

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
          Snap to grid
        </label>

        <div className="ml-auto flex items-center gap-2">
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
            selectedTableId={selectedTableId}
            drag={drag}
            onDragChange={setDrag}
            onSelectTable={setSelectedTableId}
            onMoveTable={handleMoveTable}
            onDropGuest={handleDropGuest}
            onSeatContextMenu={handleUnseat}
            onBlockSeat={(tableId, seatIndex) => handleToggleSeat(tableId, seatIndex, true)}
          />
          <p className="mt-1 text-[11px] text-[var(--gray-9)]">
            Drag a table to move it. Drag a name from the list onto a seat, or drag a seated guest to
            another seat to swap them. Right-click a seat to empty it.
          </p>
        </div>

        <div className="w-60 flex-shrink-0 overflow-y-auto rounded-lg border border-[var(--gray-6)] p-2">
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
