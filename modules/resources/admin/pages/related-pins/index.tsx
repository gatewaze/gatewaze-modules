import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { yupResolver } from '@hookform/resolvers/yup';
import * as yup from 'yup';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import {
  PlusIcon,
  PencilIcon,
  TrashIcon,
  LinkIcon,
} from '@heroicons/react/24/outline';
import { Modal, Button, Input, Card, Badge, ConfirmModal, Select, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import {
  SrRelatedPin,
  RelatedPinsService,
} from '../../utils/structuredResourcesService';

// Curated topic -> content pairings for the related-content panel. Pins rank
// above topic-containment matches in /api/related-content, so this page is
// where editorial pairings live (e.g. voice-agents -> the voice guides).

const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

const pinSchema = yup.object({
  topic: yup.string().required('Topic is required')
    .matches(TOPIC_RE, 'Lowercase kebab-case, e.g. voice-agents'),
  title: yup.string().required('Title is required').max(200),
  href: yup.string().required('Link is required')
    .test('href', 'Site-relative path (/resources/…) or https:// URL', (v) =>
      !!v && (v.startsWith('/') || v.startsWith('https://'))),
  description: yup.string().max(300).nullable().optional(),
  image_url: yup.string().url('Must be a valid URL').nullable().optional(),
  card_type: yup.string().oneOf(['resource', 'event', 'blog', 'link']).required(),
  sort_order: yup.number().integer().min(0).required(),
  active: yup.boolean().required(),
});

type PinFormData = yup.InferType<typeof pinSchema>;

const RelatedPinsPage: React.FC = () => {
  const navigate = useNavigate();
  const [pins, setPins] = useState<SrRelatedPin[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<SrRelatedPin | null>(null);
  const [deleting, setDeleting] = useState<SrRelatedPin | null>(null);

  const form = useForm<PinFormData>({
    resolver: yupResolver(pinSchema) as any,
    defaultValues: { card_type: 'resource', sort_order: 0, active: true },
  });

  const load = async () => {
    setLoading(true);
    const result = await RelatedPinsService.getAll();
    if (result.success && result.data) setPins(result.data);
    else toast.error(result.error || 'Failed to load pins');
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const openCreate = (topic?: string) => {
    setEditing(null);
    form.reset({ topic: topic ?? '', title: '', href: '', description: '', image_url: '', card_type: 'resource', sort_order: 0, active: true });
    setShowModal(true);
  };

  const openEdit = (pin: SrRelatedPin) => {
    setEditing(pin);
    form.reset({
      topic: pin.topic,
      title: pin.title,
      href: pin.href,
      description: pin.description ?? '',
      image_url: pin.image_url ?? '',
      card_type: pin.card_type as PinFormData['card_type'],
      sort_order: pin.sort_order,
      active: pin.active,
    });
    setShowModal(true);
  };

  const onSubmit = async (data: PinFormData) => {
    setSubmitting(true);
    const input = {
      topic: data.topic,
      title: data.title.trim(),
      href: data.href.trim(),
      description: data.description?.trim() || null,
      image_url: data.image_url?.trim() || null,
      card_type: data.card_type,
      sort_order: data.sort_order,
      active: data.active,
    };
    const result = editing
      ? await RelatedPinsService.update(editing.id, input)
      : await RelatedPinsService.create(input);
    if (result.success) {
      toast.success(editing ? 'Pin updated' : 'Pin created');
      setShowModal(false);
      load();
    } else {
      toast.error(result.error || 'Failed to save pin');
    }
    setSubmitting(false);
  };

  const toggleActive = async (pin: SrRelatedPin) => {
    const result = await RelatedPinsService.update(pin.id, { active: !pin.active });
    if (result.success) load();
    else toast.error(result.error || 'Failed to update pin');
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const result = await RelatedPinsService.delete(deleting.id);
    if (result.success) { toast.success('Pin deleted'); load(); }
    else toast.error(result.error || 'Failed to delete pin');
    setDeleting(null);
  };

  const byTopic = pins.reduce<Record<string, SrRelatedPin[]>>((acc, pin) => {
    (acc[pin.topic] ||= []).push(pin);
    return acc;
  }, {});

  return (
    <Page title="Related Pins">
      <WorkspaceLayout
        title="Related pins"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate('/resources/collections')}>← Collections</Button>
            <Button onClick={() => openCreate()}>
              <PlusIcon className="h-4 w-4 mr-1" /> New Pin
            </Button>
          </div>
        }
      >
        <p className="text-sm text-[var(--gray-11)] mb-4">
          Curated pairings shown in the portal's "Related" panel when a visitor engages with content
          carrying a topic. Pins always rank above automatic topic matches.
        </p>
        {loading ? (
          <div className="text-center py-12 text-gray-500">Loading...</div>
        ) : pins.length === 0 ? (
          <Card className="text-center py-12">
            <LinkIcon className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500">No pins yet. Pin content to a topic to curate the Related panel.</p>
          </Card>
        ) : (
          <div className="space-y-6">
            {Object.entries(byTopic).map(([topic, topicPins]) => (
              <div key={topic}>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="font-semibold text-gray-900 dark:text-white font-mono text-sm">{topic}</h3>
                  <button
                    onClick={() => openCreate(topic)}
                    className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                    title={`Add a pin to ${topic}`}
                  >
                    <PlusIcon className="w-4 h-4" />
                  </button>
                </div>
                <div className="space-y-2">
                  {topicPins.map((pin) => (
                    <Card key={pin.id} className="flex items-center gap-3 p-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 dark:text-white truncate">{pin.title}</span>
                          <Badge color={pin.active ? 'success' : 'neutral'}>{pin.active ? 'active' : 'inactive'}</Badge>
                          <Badge color="neutral">{pin.card_type}</Badge>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-[var(--gray-a9)] font-mono truncate">{pin.href}</span>
                          {pin.description && <span className="text-sm text-[var(--gray-11)] truncate">{pin.description}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => toggleActive(pin)}
                          className="px-2 py-1 text-xs rounded border border-[var(--gray-a5)] text-[var(--gray-11)] hover:bg-gray-100 dark:hover:bg-gray-800"
                        >
                          {pin.active ? 'Deactivate' : 'Activate'}
                        </button>
                        <button onClick={() => openEdit(pin)} className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded">
                          <PencilIcon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                        </button>
                        <button onClick={() => setDeleting(pin)} className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/20 rounded">
                          <TrashIcon className="w-4 h-4 text-red-600 dark:text-red-400" />
                        </button>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </WorkspaceLayout>

      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editing ? 'Edit Pin' : 'New Pin'}
      >
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Topic"
              placeholder="voice-agents"
              {...form.register('topic')}
              error={form.formState.errors.topic?.message}
            />
            <Select
              label="Card type"
              {...form.register('card_type')}
              data={[
                { value: 'resource', label: 'Resource' },
                { value: 'event', label: 'Event' },
                { value: 'blog', label: 'Blog' },
                { value: 'link', label: 'Link' },
              ]}
            />
          </div>
          <Input
            label="Title"
            placeholder="The Buyer's Guide to Voice Agents"
            {...form.register('title')}
            error={form.formState.errors.title?.message}
          />
          <Input
            label="Link"
            placeholder="/resources/buyers-guides/voice-agents"
            {...form.register('href')}
            error={form.formState.errors.href?.message}
          />
          <Input
            label="Description"
            placeholder="One or two lines shown under the title"
            {...form.register('description')}
            error={form.formState.errors.description?.message}
          />
          <div className="grid grid-cols-3 gap-3">
            <Input
              label="Image URL"
              {...form.register('image_url')}
              error={form.formState.errors.image_url?.message}
            />
            <Input
              label="Sort order"
              type="number"
              {...form.register('sort_order', { valueAsNumber: true })}
              error={form.formState.errors.sort_order?.message}
            />
            <label className="flex items-end gap-2 pb-2">
              <input type="checkbox" {...form.register('active')} />
              <span className="text-sm">Active</span>
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setShowModal(false)}>Cancel</Button>
            <Button type="submit" disabled={submitting}>{editing ? 'Save Changes' : 'Create Pin'}</Button>
          </div>
        </form>
      </Modal>

      <ConfirmModal
        isOpen={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title="Delete Pin"
        message={`Delete the "${deleting?.title}" pin from topic "${deleting?.topic}"? The Related panel stops showing it immediately.`}
        confirmText="Delete"
        confirmColor="red"
      />
    </Page>
  );
};

export default RelatedPinsPage;
