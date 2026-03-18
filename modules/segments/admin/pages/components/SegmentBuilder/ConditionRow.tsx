import React from 'react';
import { TrashIcon } from '@heroicons/react/24/outline';
import { Button, Card } from '@/components/ui';
import { AttributeConditionFields } from './AttributeConditionFields';
import { EventConditionFields } from './EventConditionFields';
import {
  SegmentCondition,
  AttributeCondition,
  EventCondition,
  isAttributeCondition,
  isEventCondition,
  createEmptyAttributeCondition,
  createEmptyEventCondition,
} from '@/lib/segments';

interface ConditionRowProps {
  condition: SegmentCondition;
  onChange: (condition: SegmentCondition) => void;
  onRemove: () => void;
  depth: number;
}

const conditionTypes = [
  { value: 'attribute', label: 'Customer Attribute' },
  { value: 'event', label: 'Customer Event' },
];

export function ConditionRow({
  condition,
  onChange,
  onRemove,
  depth,
}: ConditionRowProps) {
  const handleTypeChange = (newType: 'attribute' | 'event') => {
    if (newType === 'attribute') {
      onChange(createEmptyAttributeCondition());
    } else {
      onChange(createEmptyEventCondition());
    }
  };

  const currentType = isAttributeCondition(condition) ? 'attribute' : 'event';

  return (
    <Card
      skin="bordered"
      className="p-4 hover:shadow-sm transition-shadow"
    >
      <div className="flex items-start gap-4">
        {/* Condition Type Selector */}
        <div className="flex-shrink-0 w-44">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Type
          </label>
          <select
            value={currentType}
            onChange={(e) => handleTypeChange(e.target.value as 'attribute' | 'event')}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            {conditionTypes.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </div>

        {/* Condition Fields */}
        <div className="flex-1 min-w-0">
          {isAttributeCondition(condition) && (
            <AttributeConditionFields
              condition={condition}
              onChange={onChange}
            />
          )}
          {isEventCondition(condition) && (
            <EventConditionFields
              condition={condition}
              onChange={onChange}
            />
          )}
        </div>

        {/* Remove Button */}
        <Button
          variant="flat"
          color="error"
          isIcon
          className="size-9 flex-shrink-0 mt-5"
          onClick={onRemove}
          title="Remove condition"
        >
          <TrashIcon className="size-4" />
        </Button>
      </div>
    </Card>
  );
}
