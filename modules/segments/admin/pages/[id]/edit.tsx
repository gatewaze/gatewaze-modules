import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  FunnelIcon,
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
  isValidSegmentDefinition,
} from '@/lib/segments';
import type { Segment, SegmentDefinition, SegmentType, SegmentStatus } from '@/lib/segments';
import { SegmentBuilder } from '../components/SegmentBuilder';

export default function EditSegmentPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [segment, setSegment] = useState<Segment | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<SegmentType>('dynamic');
  const [status, setStatus] = useState<SegmentStatus>('active');
  const [definition, setDefinition] = useState<SegmentDefinition>({
    match: 'all',
    conditions: [],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const segmentService = useMemo(
    () => (supabase ? createSegmentService(supabase) : null),
    []
  );

  useEffect(() => {
    const loadSegment = async () => {
      if (!segmentService || !id) return;

      try {
        setLoading(true);
        const data = await segmentService.getSegment(id);
        if (!data) {
          toast.error('Segment not found');
          navigate('/segments');
          return;
        }
        setSegment(data);
        setName(data.name);
        setDescription(data.description || '');
        setType(data.type);
        setStatus(data.status);
        setDefinition(data.definition);
      } catch (error) {
        console.error('Error loading segment:', error);
        toast.error('Failed to load segment');
        navigate('/segments');
      } finally {
        setLoading(false);
      }
    };

    loadSegment();
  }, [id, segmentService, navigate]);

  const canSave = name.trim() && isValidSegmentDefinition(definition);

  const handleSave = async () => {
    if (!segmentService || !id || !canSave) return;

    setSaving(true);
    try {
      const updated = await segmentService.updateSegment(id, {
        name: name.trim(),
        description: description.trim() || undefined,
        definition,
        status,
      });

      toast.success(`Segment "${updated.name}" updated successfully`);
      navigate(`/segments/${id}`);
    } catch (error) {
      console.error('Error updating segment:', error);
      toast.error('Failed to update segment');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Page title="Loading Segment...">
        <div className="flex items-center justify-center h-96">
          <Spinner className="size-8" />
        </div>
      </Page>
    );
  }

  if (!segment) {
    return (
      <Page title="Segment Not Found">
        <div className="flex flex-col items-center justify-center h-96 gap-4">
          <FunnelIcon className="size-12 text-gray-400" />
          <p className="text-gray-600 dark:text-gray-400">Segment not found</p>
          <Button onClick={() => navigate('/segments')}>Back to Segments</Button>
        </div>
      </Page>
    );
  }

  return (
    <Page title={`Edit ${segment.name}`}>
      <div className="p-6 space-y-6 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="flat"
              isIcon
              onClick={() => navigate(`/segments/${id}`)}
              className="size-10"
            >
              <ArrowLeftIcon className="size-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
                Edit Segment
              </h1>
              <p className="text-neutral-600 dark:text-neutral-400 mt-1">
                Update segment conditions and settings
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
                Saving...
              </>
            ) : (
              <>
                <CheckIcon className="size-4" />
                Save Changes
              </>
            )}
          </Button>
        </div>

        {/* Basic Info */}
        <Card variant="surface" className="p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Basic Information
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Input
              label="Segment Name"
              placeholder="e.g., Active KubeCon Attendees"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Type
              </label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as SegmentType)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <option value="dynamic">Dynamic</option>
                <option value="static">Static</option>
                <option value="manual">Manual</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Status
              </label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as SegmentStatus)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="archived">Archived</option>
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
        <div className="flex justify-between">
          <Button
            variant="outlined"
            color="error"
            onClick={() => {
              // Reset to original
              if (segment) {
                setName(segment.name);
                setDescription(segment.description || '');
                setType(segment.type);
                setStatus(segment.status);
                setDefinition(segment.definition);
                toast.info('Changes discarded');
              }
            }}
          >
            Discard Changes
          </Button>
          <div className="flex gap-3">
            <Button variant="outlined" onClick={() => navigate(`/segments/${id}`)}>
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
                  Saving...
                </>
              ) : (
                <>
                  <CheckIcon className="size-4" />
                  Save Changes
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </Page>
  );
}
