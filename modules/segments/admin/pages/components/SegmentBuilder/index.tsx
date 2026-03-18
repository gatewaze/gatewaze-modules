import React from 'react';
import { PlusIcon } from '@heroicons/react/24/outline';
import { Button, Card } from '@/components/ui';
import { ConditionGroup } from './ConditionGroup';
import { SegmentPreview } from '../SegmentPreview';
import {
  SegmentDefinition,
  SegmentCondition,
  createEmptyAttributeCondition,
  createEmptyGroupCondition,
} from '@/lib/segments';

interface SegmentBuilderProps {
  value: SegmentDefinition;
  onChange: (definition: SegmentDefinition) => void;
  showPreview?: boolean;
}

export function SegmentBuilder({
  value,
  onChange,
  showPreview = true,
}: SegmentBuilderProps) {
  const handleMatchChange = (match: 'all' | 'any') => {
    onChange({ ...value, match });
  };

  const handleConditionsChange = (conditions: SegmentCondition[]) => {
    onChange({ ...value, conditions });
  };

  const handleAddCondition = () => {
    onChange({
      ...value,
      conditions: [...value.conditions, createEmptyAttributeCondition()],
    });
  };

  const handleAddGroup = () => {
    onChange({
      ...value,
      conditions: [...value.conditions, createEmptyGroupCondition()],
    });
  };

  return (
    <div className="space-y-6">
      {/* Root Match Selector */}
      <Card skin="bordered" className="p-4 bg-gray-50/50 dark:bg-gray-800/50">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Include customers where
          </span>
          <select
            value={value.match}
            onChange={(e) => handleMatchChange(e.target.value as 'all' | 'any')}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm font-medium text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="all">ALL of the following are true</option>
            <option value="any">ANY of the following are true</option>
          </select>
        </div>
      </Card>

      {/* Conditions */}
      {value.conditions.length > 0 && (
        <ConditionGroup
          conditions={value.conditions}
          onChange={handleConditionsChange}
          match={value.match}
          depth={0}
        />
      )}

      {/* Add Condition/Group Buttons */}
      <div className="flex gap-3 flex-wrap">
        <Button variant="outlined" onClick={handleAddCondition} className="gap-2">
          <PlusIcon className="size-4" />
          Add Condition
        </Button>
        <Button variant="outlined" color="secondary" onClick={handleAddGroup} className="gap-2">
          <PlusIcon className="size-4" />
          Add Group
        </Button>
      </div>

      {/* Live Preview */}
      {showPreview && <SegmentPreview definition={value} />}
    </div>
  );
}

export { ConditionGroup } from './ConditionGroup';
export { ConditionRow } from './ConditionRow';
export { AttributeConditionFields } from './AttributeConditionFields';
export { EventConditionFields } from './EventConditionFields';
