import React from 'react';
import { Input } from '@/components/ui/Form';
import {
  AttributeCondition,
  SegmentCondition,
  ATTRIBUTE_FIELDS,
  ATTRIBUTE_OPERATORS,
} from '@/lib/segments';

interface AttributeConditionFieldsProps {
  condition: AttributeCondition;
  onChange: (condition: SegmentCondition) => void;
}

export function AttributeConditionFields({
  condition,
  onChange,
}: AttributeConditionFieldsProps) {
  const selectedOperator = ATTRIBUTE_OPERATORS.find(
    (op) => op.value === condition.operator
  );
  const requiresValue = selectedOperator?.requiresValue !== false;

  const handleFieldChange = (field: string) => {
    onChange({ ...condition, field });
  };

  const handleOperatorChange = (operator: string) => {
    onChange({
      ...condition,
      operator: operator as AttributeCondition['operator'],
      // Clear value if operator doesn't require it
      value: ATTRIBUTE_OPERATORS.find((op) => op.value === operator)?.requiresValue
        ? condition.value
        : '',
    });
  };

  const handleValueChange = (value: string) => {
    onChange({ ...condition, value });
  };

  return (
    <div className="flex items-end gap-3 flex-wrap">
      {/* Field Selector */}
      <div className="flex-1 min-w-[180px]">
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          Field
        </label>
        <select
          value={condition.field}
          onChange={(e) => handleFieldChange(e.target.value)}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          <option value="">Select field...</option>
          {ATTRIBUTE_FIELDS.map((field) => (
            <option key={field.value} value={field.value}>
              {field.label}
            </option>
          ))}
          <option value="custom">Custom field...</option>
        </select>
      </div>

      {/* Custom Field Input */}
      {condition.field === 'custom' && (
        <div className="min-w-[160px]">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Field Path
          </label>
          <Input
            placeholder="attributes.field_name"
            value={condition.field === 'custom' ? '' : condition.field}
            onChange={(e) => handleFieldChange(e.target.value)}
            classNames={{ root: 'w-full' }}
          />
        </div>
      )}

      {/* Operator Selector */}
      <div className="min-w-[160px]">
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          Operator
        </label>
        <select
          value={condition.operator}
          onChange={(e) => handleOperatorChange(e.target.value)}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          {ATTRIBUTE_OPERATORS.map((op) => (
            <option key={op.value} value={op.value}>
              {op.label}
            </option>
          ))}
        </select>
      </div>

      {/* Value Input */}
      {requiresValue && (
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Value
          </label>
          {condition.operator === 'in_list' || condition.operator === 'not_in_list' ? (
            <Input
              placeholder="value1, value2, value3"
              value={
                Array.isArray(condition.value)
                  ? condition.value.join(', ')
                  : (condition.value as string) || ''
              }
              onChange={(e) => {
                const values = e.target.value
                  .split(',')
                  .map((v) => v.trim())
                  .filter(Boolean);
                onChange({ ...condition, value: values });
              }}
              classNames={{ root: 'w-full' }}
            />
          ) : (
            <Input
              placeholder="Enter value..."
              value={(condition.value as string) || ''}
              onChange={(e) => handleValueChange(e.target.value)}
              classNames={{ root: 'w-full' }}
            />
          )}
        </div>
      )}
    </div>
  );
}
