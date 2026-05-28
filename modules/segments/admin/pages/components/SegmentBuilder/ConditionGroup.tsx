import React from 'react';
import { PlusIcon } from '@heroicons/react/24/outline';
import { Button, Card } from '@/components/ui';
import { ConditionRow } from './ConditionRow';
import {
  SegmentCondition,
  GroupCondition,
  isGroupCondition,
  createEmptyAttributeCondition,
  createEmptyGroupCondition,
} from '@/lib/segments';

interface ConditionGroupProps {
  conditions: SegmentCondition[];
  onChange: (conditions: SegmentCondition[]) => void;
  match: 'all' | 'any';
  depth: number;
}

const depthColors = [
  'border-l-blue-500',
  'border-l-purple-500',
  'border-l-orange-500',
  'border-l-green-500',
];

export function ConditionGroup({
  conditions,
  onChange,
  match,
  depth,
}: ConditionGroupProps) {
  const handleConditionChange = (index: number, condition: SegmentCondition) => {
    const newConditions = [...conditions];
    newConditions[index] = condition;
    onChange(newConditions);
  };

  const handleRemoveCondition = (index: number) => {
    onChange(conditions.filter((_, i) => i !== index));
  };

  const handleAddConditionToGroup = (
    index: number,
    type: 'attribute' | 'group'
  ) => {
    const group = conditions[index] as GroupCondition;
    const newCondition =
      type === 'group'
        ? createEmptyGroupCondition()
        : createEmptyAttributeCondition();
    const newGroup = {
      ...group,
      conditions: [...group.conditions, newCondition],
    };
    handleConditionChange(index, newGroup);
  };

  const handleGroupMatchChange = (index: number, newMatch: 'all' | 'any') => {
    const group = conditions[index] as GroupCondition;
    handleConditionChange(index, { ...group, match: newMatch });
  };

  const handleGroupConditionsChange = (
    index: number,
    newConditions: SegmentCondition[]
  ) => {
    const group = conditions[index] as GroupCondition;
    handleConditionChange(index, { ...group, conditions: newConditions });
  };

  const connector = match === 'all' ? 'AND' : 'OR';
  const borderColor = depthColors[depth % depthColors.length];

  return (
    <div className="space-y-3">
      {conditions.map((condition, index) => (
        <React.Fragment key={index}>
          {/* Connector label between conditions */}
          {index > 0 && (
            <div className="flex items-center gap-2 pl-4">
              <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
              <span
                className={`text-xs font-semibold px-2 py-1 rounded ${
                  match === 'all'
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                    : 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                }`}
              >
                {connector}
              </span>
              <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
            </div>
          )}

          {isGroupCondition(condition) ? (
            /* Nested Group */
            <Card
              skin="bordered"
              className={`p-4 border-l-4 ${borderColor} bg-gray-50/50 dark:bg-gray-800/30`}
            >
              <div className="space-y-4">
                {/* Group Header */}
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      Match
                    </span>
                    <select
                      value={condition.match}
                      onChange={(e) =>
                        handleGroupMatchChange(index, e.target.value as 'all' | 'any')
                      }
                      className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 text-sm font-medium text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                    >
                      <option value="all">ALL</option>
                      <option value="any">ANY</option>
                    </select>
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      conditions in this group
                    </span>
                  </div>
                  <Button
                    variant="flat"
                    color="error"
                    size="sm"
                    onClick={() => handleRemoveCondition(index)}
                  >
                    Remove Group
                  </Button>
                </div>

                {/* Group Conditions */}
                <ConditionGroup
                  conditions={condition.conditions}
                  onChange={(newConditions) =>
                    handleGroupConditionsChange(index, newConditions)
                  }
                  match={condition.match}
                  depth={depth + 1}
                />

                {/* Add to Group */}
                <div className="flex gap-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                  <Button
                    variant="flat"
                    size="sm"
                    onClick={() => handleAddConditionToGroup(index, 'attribute')}
                    className="gap-1"
                  >
                    <PlusIcon className="size-3" />
                    Add Condition
                  </Button>
                  <Button
                    variant="flat"
                    color="secondary"
                    size="sm"
                    onClick={() => handleAddConditionToGroup(index, 'group')}
                    className="gap-1"
                  >
                    <PlusIcon className="size-3" />
                    Add Nested Group
                  </Button>
                </div>
              </div>
            </Card>
          ) : (
            /* Single Condition Row */
            <ConditionRow
              condition={condition}
              onChange={(newCondition) => handleConditionChange(index, newCondition)}
              onRemove={() => handleRemoveCondition(index)}
              depth={depth}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}
