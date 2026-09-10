import { TrashIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui';
import { seatPositions } from '../utils/seatGeometry';
import type {
  SeatingTable,
  SeatingAssignment,
  SeatLayout,
  TableShape,
} from '../utils/seatingService';
import { SEAT_LAYOUTS, TABLE_SHAPES } from '../utils/seatingService';

/**
 * Properties for the selected table, plus its seat roster. Editing seat count
 * or shape re-derives seat positions immediately; guests already seated beyond
 * the new seat count are flagged so they can be moved rather than silently
 * disappearing.
 */

interface Props {
  table: SeatingTable | null;
  assignments: SeatingAssignment[];
  namesByAssignment: Map<string, string>;
  onChange: (patch: Partial<SeatingTable>) => void;
  onDelete: () => void;
  onClearSeats: () => void;
  onUnseat: (assignmentId: string) => void;
}

const LAYOUT_LABELS: Record<SeatLayout, string> = {
  around: 'All the way round',
  both_sides: 'Both long sides',
  sides_balanced: 'Equal sides, odd one at the end',
  one_side: 'One side (top table)',
};

const SHAPE_LABELS: Record<TableShape, string> = {
  round: 'Round',
  rect: 'Rectangular',
};

export function TableInspector({
  table,
  assignments,
  namesByAssignment,
  onChange,
  onDelete,
  onClearSeats,
  onUnseat,
}: Props) {
  if (!table) {
    return (
      <div className="py-6 text-center text-xs text-[var(--gray-9)]">
        Select a table to edit it, or add one from the toolbar.
      </div>
    );
  }

  const seats = seatPositions(table);
  const tableAssignments = assignments
    .filter((a) => a.table_id === table.id)
    .sort((a, b) => a.seat_index - b.seat_index);
  const overflow = tableAssignments.filter((a) => a.seat_index >= table.seat_count);

  const field = 'w-full rounded border border-[var(--gray-6)] bg-[var(--color-background)] px-1.5 py-1 text-xs text-[var(--gray-12)]';
  const label = 'text-[10px] text-[var(--gray-9)]';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-[var(--gray-12)]">Table</h4>
        <button
          onClick={onDelete}
          title="Delete this table"
          className="cursor-pointer text-[var(--gray-9)] hover:text-red-600"
        >
          <TrashIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      <div>
        <label className={label}>Name</label>
        <input
          type="text"
          value={table.label}
          maxLength={120}
          onChange={(e) => onChange({ label: e.target.value })}
          className={field}
        />
      </div>

      <div className="grid grid-cols-2 gap-1">
        <div>
          <label className={label}>Shape</label>
          <select
            value={table.shape}
            onChange={(e) => {
              const shape = e.target.value as TableShape;
              onChange({
                shape,
                seat_layout: shape === 'round' ? 'around' : table.seat_layout,
              });
            }}
            className={field}
          >
            {TABLE_SHAPES.map((s) => (
              <option key={s} value={s}>{SHAPE_LABELS[s]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>Seats</label>
          <input
            type="number"
            min={0}
            max={40}
            value={table.seat_count}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              onChange({ seat_count: Number.isFinite(n) ? Math.max(0, Math.min(40, n)) : 0 });
            }}
            className={field}
          />
        </div>
      </div>

      {table.shape === 'rect' && (
        <div>
          <label className={label}>Seat arrangement</label>
          <select
            value={table.seat_layout}
            onChange={(e) => onChange({ seat_layout: e.target.value as SeatLayout })}
            className={field}
          >
            {SEAT_LAYOUTS.map((l) => (
              <option key={l} value={l}>{LAYOUT_LABELS[l]}</option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-1">
        <div>
          <label className={label}>{table.shape === 'round' ? 'Diameter' : 'Width'}</label>
          <input
            type="number"
            min={20}
            step={10}
            value={table.width}
            onChange={(e) => onChange({ width: parseFloat(e.target.value) || 20 })}
            className={field}
          />
        </div>
        <div>
          <label className={label}>Height</label>
          <input
            type="number"
            min={20}
            step={10}
            value={table.height}
            disabled={table.shape === 'round'}
            onChange={(e) => onChange({ height: parseFloat(e.target.value) || 20 })}
            className={`${field} disabled:opacity-40`}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1">
        <div>
          <label className={label}>Rotation</label>
          <input
            type="number"
            step={5}
            value={table.rotation}
            onChange={(e) => onChange({ rotation: parseFloat(e.target.value) || 0 })}
            className={field}
          />
        </div>
        <div>
          <label className={label}>Colour</label>
          <input
            type="color"
            value={table.colour || '#eef2f6'}
            onChange={(e) => onChange({ colour: e.target.value })}
            className="h-6 w-full cursor-pointer rounded border border-[var(--gray-6)]"
          />
        </div>
      </div>

      <div className="border-t border-[var(--gray-6)] pt-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-medium text-[var(--gray-9)]">
            Seated here — {tableAssignments.length}/{table.seat_count}
          </span>
          {tableAssignments.length > 0 && (
            <Button variant="ghost" size="1" onClick={onClearSeats}>Clear</Button>
          )}
        </div>

        {overflow.length > 0 && (
          <p className="mb-1 rounded bg-amber-100 px-1.5 py-1 text-[10px] text-amber-900">
            {overflow.length} guest{overflow.length === 1 ? '' : 's'} sit beyond seat{' '}
            {table.seat_count} and no longer show on the plan. Move them or raise the seat count.
          </p>
        )}

        <div className="space-y-0.5">
          {seats.map((seat) => {
            const assignment = tableAssignments.find((a) => a.seat_index === seat.index);
            return (
              <div
                key={seat.index}
                className="flex items-center justify-between gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-[var(--gray-3)]"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="w-4 flex-shrink-0 text-[var(--gray-9)]">{seat.index + 1}</span>
                  <span className={`truncate ${assignment ? 'text-[var(--gray-12)]' : 'text-[var(--gray-9)] italic'}`}>
                    {assignment ? namesByAssignment.get(assignment.id) || 'Guest' : 'empty'}
                  </span>
                </span>
                {assignment && (
                  <button
                    onClick={() => onUnseat(assignment.id)}
                    title="Return to the guest list"
                    className="flex-shrink-0 text-[var(--gray-9)] hover:text-red-600"
                  >
                    <TrashIcon className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}
          {overflow.map((assignment) => (
            <div
              key={assignment.id}
              className="flex items-center justify-between gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[11px]"
            >
              <span className="truncate text-amber-900">
                seat {assignment.seat_index + 1} · {namesByAssignment.get(assignment.id) || 'Guest'}
              </span>
              <button
                onClick={() => onUnseat(assignment.id)}
                className="flex-shrink-0 text-amber-700 hover:text-red-600"
              >
                <TrashIcon className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default TableInspector;
