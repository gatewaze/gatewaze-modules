import { useState, useEffect, useCallback } from 'react';
import { PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import {
  Button,
  Card,
} from '@/components/ui';
import {
  CalendarBlastService,
  AudienceFilter,
  AudienceParticipationGroup,
  AudienceMode,
  AudienceKind,
  AudienceScope,
  BlastChannel,
} from '../services/calendarBlastService';

interface CalendarEventOption {
  id: string;          // events.id (uuid)
  event_id: string;    // events.event_id (varchar slug)
  event_title: string;
}

interface Props {
  calendarId: string;
  channel: BlastChannel;
  value: AudienceFilter;
  onChange: (filter: AudienceFilter, count: number | null) => void;
  availableEvents?: CalendarEventOption[];
}

const MEMBERSHIP_TYPES = [
  { value: 'subscriber', label: 'Subscriber' },
  { value: 'member',     label: 'Member' },
  { value: 'vip',        label: 'VIP' },
  { value: 'organizer',  label: 'Organizer' },
  { value: 'admin',      label: 'Admin' },
];

const MODE_OPTIONS: { value: AudienceMode; label: string }[] = [
  { value: 'any_of',  label: 'Any of'  },
  { value: 'all_of',  label: 'All of'  },
  { value: 'none_of', label: 'None of' },
];

const KIND_OPTIONS: { value: AudienceKind; label: string }[] = [
  { value: 'registered', label: 'Registered' },
  { value: 'attended',   label: 'Attended'   },
];

const SCOPE_OPTIONS: { value: AudienceScope; label: string }[] = [
  { value: 'specific',                label: 'specific events…' },
  { value: 'any_past_calendar_event', label: 'any past event in this calendar' },
];

export function CalendarAudienceFilter({
  calendarId,
  channel,
  value,
  onChange,
  availableEvents = [],
}: Props) {
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Debounced preview fetch on filter or channel change
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      const result = await CalendarBlastService.previewAudience(calendarId, value, channel);
      if (cancelled) return;
      setPreviewLoading(false);
      if (!result.success || !result.data) {
        setPreviewCount(null);
        setPreviewError(result.error || 'Preview failed');
        onChange(value, null);
        return;
      }
      setPreviewCount(result.data.count);
      onChange(value, result.data.count);
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarId, channel, JSON.stringify(value)]);

  const toggleMembershipType = useCallback(
    (type: string) => {
      const current = value.membership_types ?? [];
      const next = current.includes(type)
        ? current.filter((t) => t !== type)
        : [...current, type];
      onChange({ ...value, membership_types: next.length > 0 ? next : undefined }, previewCount);
    },
    [value, onChange, previewCount]
  );

  const updateGroup = useCallback(
    (idx: number, patch: Partial<AudienceParticipationGroup>) => {
      const groups = [...(value.event_participation ?? [])];
      groups[idx] = { ...groups[idx], ...patch };
      onChange({ ...value, event_participation: groups }, previewCount);
    },
    [value, onChange, previewCount]
  );

  const addGroup = useCallback(() => {
    const groups = [...(value.event_participation ?? [])];
    groups.push({ mode: 'any_of', kind: 'attended', scope: 'specific', event_ids: [] });
    onChange({ ...value, event_participation: groups }, previewCount);
  }, [value, onChange, previewCount]);

  const removeGroup = useCallback(
    (idx: number) => {
      const groups = [...(value.event_participation ?? [])];
      groups.splice(idx, 1);
      onChange(
        { ...value, event_participation: groups.length > 0 ? groups : undefined },
        previewCount
      );
    },
    [value, onChange, previewCount]
  );

  const toggleEventInGroup = useCallback(
    (groupIdx: number, eventSlug: string) => {
      const groups = [...(value.event_participation ?? [])];
      const ids = [...(groups[groupIdx]?.event_ids ?? [])];
      const i = ids.indexOf(eventSlug);
      if (i >= 0) ids.splice(i, 1);
      else ids.push(eventSlug);
      groups[groupIdx] = { ...groups[groupIdx], event_ids: ids };
      onChange({ ...value, event_participation: groups }, previewCount);
    },
    [value, onChange, previewCount]
  );

  const selectedTypes = new Set(value.membership_types ?? []);
  const groups = value.event_participation ?? [];

  return (
    <Card className="p-4 space-y-4">
      <h3 className="text-sm font-semibold text-[var(--gray-12)]">Audience</h3>

      {/* Membership types */}
      <div>
        <label className="block text-xs font-medium text-[var(--gray-11)] mb-2">
          Membership types
          {selectedTypes.size === 0 && (
            <span className="ml-2 text-[var(--gray-9)] font-normal">(all)</span>
          )}
        </label>
        <div className="flex flex-wrap gap-2">
          {MEMBERSHIP_TYPES.map((t) => {
            const active = selectedTypes.has(t.value);
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => toggleMembershipType(t.value)}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  active
                    ? 'bg-[var(--accent-9)] text-white border-[var(--accent-9)]'
                    : 'bg-[var(--gray-2)] text-[var(--gray-11)] border-[var(--gray-6)] hover:border-[var(--gray-8)]'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Channel prereq */}
      {channel === 'email' && (
        <div className="text-xs text-[var(--gray-10)]">
          Only confirmed members with email notifications enabled will receive this blast.
        </div>
      )}
      {channel !== 'email' && (
        <div className="text-xs text-[var(--gray-10)]">
          Only members with a phone number on file will receive this {channel} blast.
        </div>
      )}

      {/* Event participation groups */}
      <div>
        <label className="block text-xs font-medium text-[var(--gray-11)] mb-2">
          Event participation
        </label>
        {groups.length === 0 && (
          <p className="text-xs text-[var(--gray-10)] mb-2">
            No participation filter — sending to all members matching the membership criteria above.
          </p>
        )}
        <div className="space-y-3">
          {groups.map((group, idx) => (
            <div
              key={idx}
              className="border border-[var(--gray-6)] rounded-md p-3 space-y-2"
            >
              <div className="flex items-center flex-wrap gap-2">
                <select
                  value={group.mode}
                  onChange={(e) => updateGroup(idx, { mode: e.target.value as AudienceMode })}
                  className="text-xs bg-[var(--gray-2)] border border-[var(--gray-6)] rounded px-2 py-1"
                >
                  {MODE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <select
                  value={group.kind}
                  onChange={(e) => updateGroup(idx, { kind: e.target.value as AudienceKind })}
                  className="text-xs bg-[var(--gray-2)] border border-[var(--gray-6)] rounded px-2 py-1"
                >
                  {KIND_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <span className="text-xs text-[var(--gray-10)]">for</span>
                <select
                  value={group.scope ?? 'specific'}
                  onChange={(e) =>
                    updateGroup(idx, {
                      scope: e.target.value as AudienceScope,
                      // When switching to "any past event", drop the event_ids list.
                      ...(e.target.value === 'any_past_calendar_event' ? { event_ids: [] } : {}),
                    })
                  }
                  className="text-xs bg-[var(--gray-2)] border border-[var(--gray-6)] rounded px-2 py-1"
                >
                  {SCOPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeGroup(idx)}
                  className="ml-auto text-[var(--gray-10)] hover:text-[var(--red-11)]"
                  aria-label="Remove group"
                >
                  <XMarkIcon className="size-4" />
                </button>
              </div>
              {(group.scope ?? 'specific') === 'specific' ? (
                <div className="flex flex-wrap gap-1.5">
                  {availableEvents.length === 0 && (
                    <span className="text-xs text-[var(--gray-10)]">No events linked to this calendar.</span>
                  )}
                  {availableEvents.map((ev) => {
                    const active = group.event_ids.includes(ev.event_id);
                    return (
                      <button
                        key={ev.id}
                        type="button"
                        onClick={() => toggleEventInGroup(idx, ev.event_id)}
                        className={`px-2 py-1 text-xs rounded border transition-colors ${
                          active
                            ? 'bg-[var(--accent-9)] text-white border-[var(--accent-9)]'
                            : 'bg-[var(--gray-2)] text-[var(--gray-11)] border-[var(--gray-6)] hover:border-[var(--gray-8)]'
                        }`}
                      >
                        {ev.event_title}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-[var(--gray-10)]">
                  Matches anyone with that activity on any event already linked to this calendar that has started.
                </p>
              )}
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={addGroup}
            className="text-xs"
          >
            <PlusIcon className="size-4 mr-1" />
            Add another group
          </Button>
        </div>
      </div>

      {/* Live recipient count */}
      <div className="border-t border-[var(--gray-6)] pt-3">
        <div className="text-sm font-semibold text-[var(--gray-12)]">
          {previewLoading ? (
            <span className="text-[var(--gray-10)]">Resolving audience…</span>
          ) : previewError ? (
            <span className="text-[var(--red-11)]">{previewError}</span>
          ) : previewCount === null ? (
            <span className="text-[var(--gray-10)]">—</span>
          ) : (
            <>
              {previewCount.toLocaleString()} {previewCount === 1 ? 'recipient' : 'recipients'}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
