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

  const handleDuplicate = useCallback(async () => {
    if (!activePlan) return;
    setCreating(true);
    try {
      const copy = await duplicatePlan(activePlan, {
        name: `${activePlan.name} (copy)`,
        sub_event_id: activePlan.sub_event_id,
        copyGuests: window.confirm('Copy the seated guests too? Cancel to copy the tables only.'),
      });
      setPlans((prev) => [...prev, copy]);
      setActivePlanId(copy.id);
      toast.success('Plan duplicated');
    } catch (err) {
      console.error('[event-seating] Failed to duplicate the plan:', err);
      toast.error('Could not duplicate the plan');
    } finally {
      setCreating(false);
    }
  }, [activePlan]);

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

  const handleRenamePlan = useCallback(async (name: string) => {
    if (!activePlan) return;
    handlePlanChange({ ...activePlan, name });
    try {
      await updatePlan(activePlan.id, { name });
    } catch (err) {
      console.error('[event-seating] Failed to rename the plan:', err);
      toast.error('Could not rename the plan');
    }
  }, [activePlan, handlePlanChange]);

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
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={activePlanId ?? ''}
          onChange={(e) => setActivePlanId(e.target.value)}
          className="rounded-md border border-[var(--gray-6)] bg-[var(--color-background)] px-2 py-1.5 text-sm text-[var(--gray-12)]"
        >
          {plans.map((plan) => (
            <option key={plan.id} value={plan.id}>{plan.name}</option>
          ))}
        </select>

        {activePlan && (
          <input
            type="text"
            value={activePlan.name}
            maxLength={120}
            onChange={(e) => handleRenamePlan(e.target.value)}
            className="w-56 rounded-md border border-[var(--gray-6)] bg-[var(--color-background)] px-2 py-1.5 text-sm text-[var(--gray-12)]"
          />
        )}

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

        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="1" disabled={creating} onClick={handleDuplicate}>
            <DocumentDuplicateIcon className="mr-0.5 h-3 w-3" />Duplicate
          </Button>
          <Button variant="ghost" size="1" disabled={creating} onClick={() => handleCreate(null)}>
            <PlusIcon className="mr-0.5 h-3 w-3" />New
          </Button>
          <Button variant="ghost" size="1" onClick={handleDelete}>
            <TrashIcon className="mr-0.5 h-3 w-3" />Delete
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
