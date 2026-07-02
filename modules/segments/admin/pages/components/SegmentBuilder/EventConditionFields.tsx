import React, { useEffect, useState } from 'react';
import { Input } from '@/components/ui/Form';
import { supabase } from '@/lib/supabase';
import { TrashIcon, PlusIcon } from '@heroicons/react/24/outline';
import {
  EventCondition,
  SegmentCondition,
  PropertyFilter,
  AttributeOperator,
  EVENT_OPERATORS,
  TIME_UNITS,
  TimeWindow,
  createSegmentService,
} from '@/lib/segments';

interface EventConditionFieldsProps {
  condition: EventCondition;
  onChange: (condition: SegmentCondition) => void;
}

// Filterable properties of the event itself (map to events columns for
// event_registered/event_attended; to event_data keys for other event types).
const EVENT_FILTER_PROPERTIES = [
  { value: 'event_city', label: 'Event city' },
  { value: 'event_country_code', label: 'Event country (ISO-2)' },
  { value: 'event_title', label: 'Event title' },
  { value: 'event_id', label: 'Event ID' },
  { value: 'status', label: 'Registration status' },
];
const EVENT_FILTER_OPERATORS: { value: AttributeOperator; label: string }[] = [
  { value: 'equals', label: 'is' },
  { value: 'not_equals', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'starts_with', label: 'starts with' },
];

// Distinct people_events names, fetched once and shared across condition rows.
let cachedEventNames: string[] | null = null;
let eventNamesInFlight: Promise<string[]> | null = null;

function loadEventNames(): Promise<string[]> {
  if (cachedEventNames) return Promise.resolve(cachedEventNames);
  if (!eventNamesInFlight) {
    eventNamesInFlight = (async () => {
      if (!supabase) return [];
      try {
        const names = await createSegmentService(supabase).listEventNames();
        cachedEventNames = names;
        return names;
      } catch {
        return [];
      }
    })();
  }
  return eventNamesInFlight;
}

export function EventConditionFields({
  condition,
  onChange,
}: EventConditionFieldsProps) {
  const [eventNames, setEventNames] = useState<string[]>(cachedEventNames || []);

  useEffect(() => {
    let active = true;
    loadEventNames().then((names) => {
      if (active) setEventNames(names);
    });
    return () => {
      active = false;
    };
  }, []);

  const selectedOperator = EVENT_OPERATORS.find(
    (op) => op.value === condition.operator
  );
  const requiresValue = selectedOperator?.requiresValue === true;

  const handleEventTypeChange = (event_type: string) => {
    onChange({ ...condition, event_type });
  };

  const handleOperatorChange = (operator: string) => {
    onChange({
      ...condition,
      operator: operator as EventCondition['operator'],
      value: requiresValue ? condition.value || 1 : undefined,
    });
  };

  const handleValueChange = (value: number) => {
    onChange({ ...condition, value });
  };

  const handleTimeWindowToggle = (enabled: boolean) => {
    if (enabled) {
      onChange({
        ...condition,
        time_window: {
          type: 'relative',
          relative_value: 30,
          relative_unit: 'days',
        },
      });
    } else {
      const { time_window, ...rest } = condition;
      onChange(rest as EventCondition);
    }
  };

  const handleTimeWindowChange = (updates: Partial<TimeWindow>) => {
    onChange({
      ...condition,
      time_window: {
        ...condition.time_window!,
        ...updates,
      } as TimeWindow,
    });
  };

  // --- Event property filters (e.g. "registered for an event in <city>") -----
  const filters: PropertyFilter[] = condition.event_filters ?? [];
  const setFilters = (next: PropertyFilter[]) => {
    const { event_filters, ...rest } = condition;
    onChange(next.length > 0 ? { ...rest, event_filters: next } : (rest as EventCondition));
  };
  const addFilter = () => setFilters([...filters, { property: 'event_city', operator: 'equals', value: '' }]);
  const updateFilter = (i: number, patch: Partial<PropertyFilter>) =>
    setFilters(filters.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const removeFilter = (i: number) => setFilters(filters.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-3">
      {/* Main Event Configuration */}
      <div className="flex items-end gap-3 flex-wrap">
        {/* Operator */}
        <div className="min-w-[160px]">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Condition
          </label>
          <select
            value={condition.operator}
            onChange={(e) => handleOperatorChange(e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            {EVENT_OPERATORS.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </select>
        </div>

        {/* Event Name (from people_events) */}
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Event
          </label>
          <input
            list="segment-event-names"
            value={condition.event_type}
            onChange={(e) => handleEventTypeChange(e.target.value)}
            placeholder="e.g. event_registered"
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          <datalist id="segment-event-names">
            {eventNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>

        {/* Count Value (for at_least, at_most, count operators) */}
        {requiresValue && (
          <div className="w-24">
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              Times
            </label>
            <Input
              type="number"
              min={1}
              value={condition.value || 1}
              onChange={(e) => handleValueChange(parseInt(e.target.value) || 1)}
              classNames={{ root: 'w-full' }}
            />
          </div>
        )}

        {/* Time Window Toggle */}
        <div className="min-w-[120px]">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Time Filter
          </label>
          <select
            value={condition.time_window ? 'enabled' : 'disabled'}
            onChange={(e) => handleTimeWindowToggle(e.target.value === 'enabled')}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="disabled">Any time</option>
            <option value="enabled">Within...</option>
          </select>
        </div>
      </div>

      {/* Time Window Configuration */}
      {condition.time_window && (
        <div className="flex items-center gap-3 pl-4 border-l-2 border-gray-200 dark:border-gray-600">
          <span className="text-sm text-gray-600 dark:text-gray-400">
            In the last
          </span>
          <div className="w-20">
            <Input
              type="number"
              min={1}
              value={condition.time_window.relative_value || 30}
              onChange={(e) =>
                handleTimeWindowChange({
                  relative_value: parseInt(e.target.value) || 1,
                })
              }
              classNames={{ root: 'w-full' }}
            />
          </div>
          <select
            value={condition.time_window.relative_unit || 'days'}
            onChange={(e) =>
              handleTimeWindowChange({
                relative_unit: e.target.value as TimeWindow['relative_unit'],
              })
            }
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            {TIME_UNITS.map((unit) => (
              <option key={unit.value} value={unit.value}>
                {unit.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Event property filters — e.g. only events in a given city */}
      <div className="pl-4 border-l-2 border-gray-200 dark:border-gray-600 space-y-2">
        {filters.map((f, i) => (
          <div key={i} className="flex items-end gap-2 flex-wrap">
            <span className="text-sm text-gray-600 dark:text-gray-400 pb-2">where the event's</span>
            <select
              value={f.property}
              onChange={(e) => updateFilter(i, { property: e.target.value })}
              className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              {EVENT_FILTER_PROPERTIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
            <select
              value={f.operator}
              onChange={(e) => updateFilter(i, { operator: e.target.value as AttributeOperator })}
              className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              {EVENT_FILTER_OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input
              value={typeof f.value === 'string' ? f.value : ''}
              onChange={(e) => updateFilter(i, { value: e.target.value })}
              placeholder="e.g. San Francisco"
              className="flex-1 min-w-[140px] rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <button type="button" onClick={() => removeFilter(i)} title="Remove filter" className="p-2 text-gray-400 hover:text-red-500">
              <TrashIcon className="size-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addFilter}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline"
        >
          <PlusIcon className="size-3" /> Add event property filter (e.g. event city)
        </button>
      </div>

      {/* Hint */}
      {!condition.event_type && (
        <div className="text-xs text-gray-500 dark:text-gray-400 pl-1">
          Pick a tracked event, or type a custom event name.
        </div>
      )}
    </div>
  );
}
