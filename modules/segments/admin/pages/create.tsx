import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowLeftIcon,
  CheckIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button } from '@/components/ui';
import { Input, Textarea } from '@/components/ui/Form';
import { Spinner } from '@/components/ui/Spinner';
import { Page } from '@/components/shared/Page';
import { supabase } from '@/lib/supabase';
import {
  createSegmentService,
  createEmptySegmentDefinition,
  isValidSegmentDefinition,
} from '@/lib/segments';
import type { SegmentDefinition, SegmentType } from '@/lib/segments';
import { SegmentBuilder } from './components/SegmentBuilder';

export default function CreateSegmentPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<SegmentType>('dynamic');
  const [definition, setDefinition] = useState<SegmentDefinition>(
    createEmptySegmentDefinition()
  );
  const [saving, setSaving] = useState(false);

  const segmentService = useMemo(
    () => (supabase ? createSegmentService(supabase) : null),
    []
  );

  const canSave = name.trim() && isValidSegmentDefinition(definition);

  const handleSave = async () => {
    if (!segmentService || !canSave) return;

    setSaving(true);
    try {
      const segment = await segmentService.createSegment({
        name: name.trim(),
        description: description.trim() || undefined,
        definition,
        type,
      });

      toast.success(`Segment "${segment.name}" created successfully`);
      navigate(`/segments/${segment.id}`);
    } catch (error) {
      console.error('Error creating segment:', error);
      toast.error('Failed to create segment');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Page title="Create Segment">
      <div className="p-6 space-y-6 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="flat"
              isIcon
              onClick={() => navigate('/segments')}
              className="size-10"
            >
              <ArrowLeftIcon className="size-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
                Create Segment
              </h1>
              <p className="text-neutral-600 dark:text-neutral-400 mt-1">
                Define conditions to create a new customer segment
              </p>
            </div>
          </div>
          <Button
            color="primary"
            onClick={handleSave}
            disabled={!canSave || saving}
            className="gap-2"
          >
            {saving ? (
              <>
                <Spinner className="size-4" />
                Creating...
              </>
            ) : (
              <>
                <CheckIcon className="size-4" />
                Create Segment
              </>
            )}
          </Button>
        </div>

        {/* Basic Info */}
        <Card variant="surface" className="p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Basic Information
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Segment Name"
              placeholder="e.g., Active KubeCon Attendees"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Segment Type
              </label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as SegmentType)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <option value="dynamic">Dynamic (recalculated on each query)</option>
                <option value="static">Static (cached membership)</option>
                <option value="manual">Manual (hand-picked members)</option>
              </select>
            </div>
          </div>
          <Textarea
            label="Description (optional)"
            placeholder="Describe who this segment targets and how it will be used..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </Card>

        {/* Segment Builder */}
        <Card variant="surface" className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Segment Conditions
            </h2>
            {definition.conditions.length > 0 && (
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {definition.conditions.length} condition
                {definition.conditions.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <SegmentBuilder
            value={definition}
            onChange={setDefinition}
            showPreview={true}
          />
        </Card>

        {/* Footer Actions */}
        <div className="flex justify-end gap-3">
          <Button variant="outlined" onClick={() => navigate('/segments')}>
            Cancel
          </Button>
          <Button
            color="primary"
            onClick={handleSave}
            disabled={!canSave || saving}
            className="gap-2"
          >
            {saving ? (
              <>
                <Spinner className="size-4" />
                Creating...
              </>
            ) : (
              <>
                <CheckIcon className="size-4" />
                Create Segment
              </>
            )}
          </Button>
        </div>
      </div>
    </Page>
  );
}
