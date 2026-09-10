import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, Card } from '@/components/ui';
import { PlusIcon, TrashIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import {
  createPlan,
  deletePlan,
  duplicatePlan,
  getPlans,
  getSubEvents,
  updatePlan,
  RSVP_STATUSES,
  type RsvpStatus,
  type SeatingPlan,
  type SubEvent,
} from './utils/seatingService';

// Lazily loaded to keep the canvas (and pdf-lib) out of the event page's
// initial chunk — the same pattern the invites tab uses.
const SeatingBoard = React.lazy(() =>
  import('./components/SeatingBoard').then((m) => ({ default: m.SeatingBoard })),
);

interface Props {
  eventUuid: string;
  eventTitle?: string;
}

/** "Layout 3" — the lowest number not already taken, so deletes can be reused. */
function nextLayoutName(plans: SeatingPlan[]): string {
  const taken = new Set(plans.map((p) => p.name.trim().toLowerCase()));
  for (let n = plans.length + 1; ; n++) {
    const candidate = `Layout ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

const STATUS_LABELS: Record<RsvpStatus, string> = {
  accepted: 'Accepted',
  pending: 'Not replied',
  maybe: 'Maybe',
  declined: 'Declined',
};

export function EventSeatingTab({ eventUuid, eventTitle }: Props) {
  const [plans, setPlans] = useState<SeatingPlan[]>([]);
  const [subEvents, setSubEvents] = useState<SubEvent[]>([]);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [planRows, subEventRows] = await Promise.all([
        getPlans(eventUuid),
        getSubEvents(eventUuid),
      ]);
      setPlans(planRows);
      setSubEvents(subEventRows);
      setActivePlanId((current) =>
        current && planRows.some((p) => p.id === current) ? current : planRows[0]?.id ?? null);
    } catch (err) {
      console.error('[event-seating] Failed to load seating plans:', err);
      toast.error('Could not load seating plans');
    } finally {
      setLoading(false);
    }
  }, [eventUuid]);

  useEffect(() => { load(); }, [load]);

  const activePlan = plans.find((p) => p.id === activePlanId) || null;
  const subEventName = useMemo(() => {
    if (!activePlan?.sub_event_id) return '';
    return subEvents.find((s) => s.id === activePlan.sub_event_id)?.name || '';
  }, [activePlan, subEvents]);

  const handleCreate = useCallback(async (subEventId: string | null) => {
    setCreating(true);
    try {
      const subEvent = subEventId ? subEvents.find((s) => s.id === subEventId) : null;
      const plan = await createPlan({
        event_id: eventUuid,
        sub_event_id: subEventId,
        name: subEvent ? `${subEvent.name} seating` : 'Seating plan',
      });
      setPlans((prev) => [...prev, plan]);
      setActivePlanId(plan.id);
    } catch (err) {
      console.error('[event-seating] Failed to create a plan:', err);
      toast.error('Could not create the plan');
    } finally {
      setCreating(false);
    }
  }, [eventUuid, subEvents]);

  const handleDelete = useCallback(async () => {
    if (!activePlan) return;
    if (!window.confirm(`Delete "${activePlan.name}"? Its tables and seat assignments go with it.`)) return;
    try {
      await deletePlan(activePlan.id);
      setPlans((prev) => prev.filter((p) => p.id !== activePlan.id));
      setActivePlanId((current) =>
        current === activePlan.id ? plans.find((p) => p.id !== activePlan.id)?.id ?? null : current);
    } catch (err) {
      console.error('[event-seating] Failed to delete the plan:', err);
      toast.error('Could not delete the plan');
    }
  }, [activePlan, plans]);

  const handlePlanChange = useCallback((next: SeatingPlan) => {
    setPlans((prev) => prev.map((p) => (p.id === next.id ? next : p)));
  }, []);

  const handleRenamePlan = useCallback(async (planId: string, rawName: string) => {
    const name = rawName.trim().slice(0, 120);
    const target = plans.find((p) => p.id === planId);
    if (!target || !name || name === target.name) return;
    handlePlanChange({ ...target, name });
    try {
      await updatePlan(planId, { name });
    } catch (err) {
      console.error('[event-seating] Failed to rename the layout:', err);
      toast.error('Could not rename the layout');
      handlePlanChange(target);
    }
  }, [plans, handlePlanChange]);

  /**
   * A new layout is nearly always a variation on one that already exists, so
   * "+" copies the current layout's tables rather than starting from nothing.
   * `copyGuests` decides whether the seating comes with it: keeping it lets
   * you nudge one table without re-seating everyone, dropping it gives the
   * same room to fill differently. An empty canvas is a separate action.
   */
  const handleAddLayout = useCallback(async (copyGuests: boolean) => {
    if (!activePlan) { handleCreate(null); return; }
    setCreating(true);
    try {
      const created = await duplicatePlan(activePlan, {
        name: nextLayoutName(plans),
        sub_event_id: activePlan.sub_event_id,
        copyGuests,
      });
      setPlans((prev) => [...prev, created]);
      setActivePlanId(created.id);
      toast.success(copyGuests ? 'Layout copied with its seating' : 'Layout copied — tables only');
    } catch (err) {
      console.error('[event-seating] Failed to add a layout:', err);
      toast.error('Could not add the layout');
    } finally {
      setCreating(false);
    }
  }, [activePlan, plans, handleCreate]);

  const handleEmptyLayout = useCallback(async () => {
    setCreating(true);
    try {
      const created = await createPlan({
        event_id: eventUuid,
        sub_event_id: activePlan?.sub_event_id ?? null,
        name: nextLayoutName(plans),
        guest_statuses: activePlan?.guest_statuses ?? ['accepted'],
      });
      setPlans((prev) => [...prev, created]);
      setActivePlanId(created.id);
    } catch (err) {
      console.error('[event-seating] Failed to create a layout:', err);
      toast.error('Could not create the layout');
    } finally {
      setCreating(false);
    }
  }, [eventUuid, activePlan, plans]);

  const handleStatusToggle = useCallback(async (status: RsvpStatus, include: boolean) => {
    if (!activePlan) return;
    const next = include
      ? [...new Set([...activePlan.guest_statuses, status])]
      : activePlan.guest_statuses.filter((s) => s !== status);
    if (next.length === 0) {
      toast.error('The plan needs at least one RSVP status');
      return;
    }
    handlePlanChange({ ...activePlan, guest_statuses: next });
    try {
      await updatePlan(activePlan.id, { guest_statuses: next });
    } catch (err) {
      console.error('[event-seating] Failed to change guest statuses:', err);
      toast.error('Could not change which guests are listed');
    }
  }, [activePlan, handlePlanChange]);

  if (loading) {
    return <div className="py-10 text-center text-sm text-[var(--gray-9)]">Loading seating…</div>;
  }

  if (plans.length === 0) {
    return (
      <Card className="p-6">
        <h3 className="text-base font-semibold text-[var(--gray-12)]">Seating plans</h3>
        <p className="mt-1 max-w-xl text-sm text-[var(--gray-11)]">
          Build a plan for {eventTitle || 'this event'} by placing tables on a canvas and dragging
          guests who have accepted onto seats. Each sub-event gets its own plan, so the day and the
          evening can be arranged separately.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {subEvents.map((subEvent) => (
            <Button
              key={subEvent.id}
              variant="soft"
              size="2"
              disabled={creating}
              onClick={() => handleCreate(subEvent.id)}
            >
              <PlusIcon className="mr-1 h-4 w-4" />
              Plan for {subEvent.name}
            </Button>
          ))}
          <Button variant="soft" size="2" disabled={creating} onClick={() => handleCreate(null)}>
            <PlusIcon className="mr-1 h-4 w-4" />
            {subEvents.length > 0 ? 'Plan for the whole event' : 'New seating plan'}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Layout tabs — one per plan. Each keeps its own tables, seating and
          exports, so alternative arrangements sit side by side. */}
      <div className="flex items-end gap-1 overflow-x-auto border-b border-[var(--gray-6)]">
        {plans.map((plan) => {
          const isActive = plan.id === activePlanId;
          return (
            <button
              key={plan.id}
              type="button"
              onClick={() => setActivePlanId(plan.id)}
              onDoubleClick={() => setRenamingId(plan.id)}
              title={`${plan.name} — double-click to rename`}
              className={`-mb-px max-w-[240px] whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'border-[var(--accent-9)] font-medium text-[var(--gray-12)]'
                  : 'border-transparent text-[var(--gray-11)] hover:text-[var(--gray-12)]'
              }`}
            >
              {renamingId === plan.id ? (
                <input
                  autoFocus
                  type="text"
                  defaultValue={plan.name}
                  maxLength={120}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => { handleRenamePlan(plan.id, e.target.value); setRenamingId(null); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { handleRenamePlan(plan.id, e.currentTarget.value); setRenamingId(null); }
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  className="w-40 rounded border border-[var(--gray-6)] bg-[var(--color-background)] px-1 py-0.5 text-sm text-[var(--gray-12)]"
                />
              ) : (
                <span className="block truncate">{plan.name}</span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          disabled={creating}
          title="Add a layout — copies the current tables, seats left empty"
          onClick={() => handleAddLayout(false)}
          className="-mb-px border-b-2 border-transparent px-2 py-2 text-sm text-[var(--gray-9)] hover:text-[var(--accent-11)] disabled:opacity-40"
        >
          <PlusIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {subEventName && (
          <span className="text-xs text-[var(--gray-9)]">for {subEventName}</span>
        )}

        <div className="flex items-center gap-1.5 text-xs text-[var(--gray-11)]">
          <span className="text-[var(--gray-9)]">Include:</span>
          {RSVP_STATUSES.map((status) => (
            <label key={status} className="flex cursor-pointer select-none items-center gap-1">
              <input
                type="checkbox"
                checked={!!activePlan?.guest_statuses.includes(status)}
                onChange={(e) => handleStatusToggle(status, e.target.checked)}
                className="cursor-pointer"
              />
              {STATUS_LABELS[status]}
            </label>
          ))}
        </div>

        {/* `soft`, not `ghost`: a Radix ghost button offsets itself by its own
            padding (--button-ghost-padding-x, 8px at size 1), so its hover
            surface bleeds 8px past its layout box on each side and adjacent
            ghosts visibly overlap in a tight row. Soft matches the board
            toolbar below anyway. */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            variant="soft"
            size="1"
            disabled={creating}
            title="Copy this layout including where everyone is sitting"
            onClick={() => handleAddLayout(true)}
          >
            <DocumentDuplicateIcon className="mr-1 h-3 w-3" />Duplicate with seating
          </Button>
          <Button
            variant="soft"
            size="1"
            disabled={creating}
            title="Start a layout from an empty canvas"
            onClick={handleEmptyLayout}
          >
            <PlusIcon className="mr-1 h-3 w-3" />Empty
          </Button>
          <Button variant="soft" size="1" color="red" onClick={handleDelete}>
            <TrashIcon className="mr-1 h-3 w-3" />Delete
          </Button>
        </div>
      </div>

      {activePlan && (
        <Suspense
          fallback={<div className="py-10 text-center text-sm text-[var(--gray-9)]">Loading board…</div>}
        >
          <SeatingBoard
            key={activePlan.id}
            plan={activePlan}
            eventUuid={eventUuid}
            subEventName={subEventName}
            onPlanChange={handlePlanChange}
          />
        </Suspense>
      )}
    </div>
  );
}

export default EventSeatingTab;
