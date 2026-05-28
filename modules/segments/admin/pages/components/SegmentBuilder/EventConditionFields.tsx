import React from 'react';
import { Input } from '@/components/ui/Form';
import {
  EventCondition,
  SegmentCondition,
  EVENT_TYPES,
  EVENT_OPERATORS,
  TIME_UNITS,
  TimeWindow,
} from '@/lib/segments';

interface EventConditionFieldsProps {
  condition: EventCondition;
  onChange: (condition: SegmentCondition) => void;
}

export function EventConditionFields({
  condition,
  onChange,
}: EventConditionFieldsProps) {
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

        {/* Event Type */}
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Event
          </label>
          <select
            value={condition.event_type}
            onChange={(e) => handleEventTypeChange(e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="">Select event...</option>
            {EVENT_TYPES.map((event) => (
              <option key={event.value} value={event.value}>
                {event.label}
              </option>
            ))}
          </select>
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

      {/* Event Description */}
      {condition.event_type && (
        <div className="text-xs text-gray-500 dark:text-gray-400 pl-1">
          {EVENT_TYPES.find((e) => e.value === condition.event_type)?.description}
        </div>
      )}
    </div>
  );
}
