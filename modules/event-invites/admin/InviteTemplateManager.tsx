import React, { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, Card, Badge, Modal } from '@/components/ui';
import { PlusIcon, PencilIcon, TrashIcon, DocumentTextIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  getTemplatesForEvent,
  deleteTemplate,
  duplicateTemplate,
  updateTemplate,
  type InviteTemplate,
} from './utils/inviteTemplateService';
import type { TemplateEditorHandle } from './utils/templateEditorHandle';

const PdfTemplateEditor = React.lazy(() => import('./PdfTemplateEditor'));
const EmailInviteTemplateEditor = React.lazy(() => import('./EmailInviteTemplateEditor'));
const SmsInviteTemplateEditor = React.lazy(() => import('./SmsInviteTemplateEditor'));

interface InviteTemplateManagerProps {
  eventUuid: string;
}

interface SubEvent {
  id: string;
  event_id: string;
  name: string;
  sort_order: number;
}

type Channel = 'pdf' | 'email' | 'sms' | 'whatsapp';

const CHANNELS: { id: Channel; label: string; icon: string }[] = [
  { id: 'pdf', label: 'PDF (Print)', icon: '\u{1F4C4}' },
  { id: 'email', label: 'Email', icon: '\u{1F4E7}' },
  { id: 'sms', label: 'SMS', icon: '\u{1F4AC}' },
  { id: 'whatsapp', label: 'WhatsApp', icon: '\u{1F4AC}' },
];

export function InviteTemplateManager({ eventUuid }: InviteTemplateManagerProps) {
  const [templates, setTemplates] = useState<InviteTemplate[]>([]);
  const [subEvents, setSubEvents] = useState<SubEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeChannel, setActiveChannel] = useState<Channel>('pdf');

  // Editor modal state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<InviteTemplate | null>(null);
  const [createSubEventId, setCreateSubEventId] = useState<string | null>(null);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<InviteTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  // Editor save state + imperative ref
  const editorRef = useRef<TemplateEditorHandle>(null);
  const [editorSaving, setEditorSaving] = useState(false);

  const handleEditorSaveClick = async () => {
    if (!editorRef.current) return;
    setEditorSaving(true);
    try {
      await editorRef.current.save();
    } catch {
      /* toast shown by editor */
    } finally {
      setEditorSaving(false);
    }
  };

  const subEventMap = new Map(subEvents.map(se => [se.id, se.name]));

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [templateData, subEventResult] = await Promise.all([
        getTemplatesForEvent(eventUuid),
        supabase
          .from('invite_sub_events')
          .select('id, event_id, name, sort_order')
          .eq('event_id', eventUuid)
          .order('sort_order'),
      ]);

      setTemplates(templateData);
      if (subEventResult.error) throw subEventResult.error;
      setSubEvents(subEventResult.data || []);
    } catch (error) {
      console.error('Error loading template data:', error);
      toast.error('Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, [eventUuid]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const filteredTemplates = templates.filter(t => t.channel === activeChannel);

  const handleToggleActive = async (template: InviteTemplate) => {
    try {
      await updateTemplate(template.id, { is_active: !template.is_active });
      toast.success(`Template ${template.is_active ? 'deactivated' : 'activated'}`);
      loadData();
    } catch (error) {
      console.error('Error toggling template:', error);
      toast.error('Failed to update template');
    }
  };

  const handleDuplicate = async (template: InviteTemplate) => {
    setDuplicatingId(template.id);
    try {
      await duplicateTemplate(template.id);
      toast.success('Template duplicated');
      loadData();
    } catch (error) {
      console.error('Error duplicating template:', error);
      toast.error('Failed to duplicate template');
    } finally {
      setDuplicatingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteTemplate(deleteTarget.id);
      toast.success('Template deleted');
      setDeleteTarget(null);
      loadData();
    } catch (error) {
      console.error('Error deleting template:', error);
      toast.error('Failed to delete template');
    } finally {
      setDeleting(false);
    }
  };

  const openCreate = () => {
    setEditingTemplate(null);
    setCreateSubEventId(null);
    setEditorOpen(true);
  };

  const openEdit = (template: InviteTemplate) => {
    setEditingTemplate(template);
    setCreateSubEventId(template.sub_event_id);
    setEditorOpen(true);
  };

  const handleEditorClose = () => {
    setEditorOpen(false);
    setEditingTemplate(null);
    setCreateSubEventId(null);
  };

  const handleEditorSave = () => {
    handleEditorClose();
    loadData();
  };

  // Determine which sub-events lack a template for the active channel
  const missingSubEvents = subEvents.filter(se => {
    const hasTemplate = templates.some(
      t => t.channel === activeChannel && t.is_active && (t.sub_event_id === se.id || t.sub_event_id === null),
    );
    return !hasTemplate;
  });

  const renderEditor = () => {
    const editorProps = {
      eventUuid,
      template: editingTemplate,
      subEventId: createSubEventId,
      onSave: handleEditorSave,
    };

    switch (activeChannel) {
      case 'pdf':
        return <PdfTemplateEditor ref={editorRef} {...editorProps} />;
      case 'email':
        return <EmailInviteTemplateEditor ref={editorRef} {...editorProps} />;
      case 'sms':
      case 'whatsapp':
        return <SmsInviteTemplateEditor ref={editorRef} {...editorProps} channel={activeChannel} />;
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <DocumentTextIcon className="w-5 h-5 text-[var(--gray-11)]" />
          <h3 className="text-sm font-semibold text-[var(--gray-12)]">Invite Templates</h3>
        </div>
        <Button variant="soft" size="1" onClick={openCreate}>
          <PlusIcon className="w-4 h-4 mr-1" />
          Create Template
        </Button>
      </div>

      {/* Channel tabs */}
      <div className="flex rounded-lg border border-[var(--gray-6)] overflow-hidden">
        {CHANNELS.map(channel => (
          <button
            key={channel.id}
            onClick={() => setActiveChannel(channel.id)}
            className={`
              flex-1 px-3 py-2 text-sm font-medium transition-colors cursor-pointer
              ${activeChannel === channel.id
                ? 'bg-[var(--accent-9)] text-white'
                : 'bg-[var(--color-background)] text-[var(--gray-11)] hover:bg-[var(--gray-3)]'
              }
              ${channel.id !== CHANNELS[0].id ? 'border-l border-[var(--gray-6)]' : ''}
            `}
          >
            <span className="mr-1.5">{channel.icon}</span>
            {channel.label}
          </button>
        ))}
      </div>

      {/* Missing template warning */}
      {missingSubEvents.length > 0 && (
        <div className="rounded-md border border-yellow-300 bg-yellow-50 dark:border-yellow-700 dark:bg-yellow-950/30 p-3">
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            The following sub-events have no active{' '}
            {CHANNELS.find(c => c.id === activeChannel)?.label} template:{' '}
            <span className="font-medium">
              {missingSubEvents.map(se => se.name).join(', ')}
            </span>
          </p>
        </div>
      )}

      {/* Template list */}
      {loading ? (
        <p className="text-sm text-[var(--gray-9)]">Loading templates...</p>
      ) : filteredTemplates.length === 0 ? (
        <Card className="p-6">
          <p className="text-sm text-[var(--gray-9)] text-center">
            No {CHANNELS.find(c => c.id === activeChannel)?.label} templates yet.
            Create one to get started.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredTemplates.map(template => (
            <Card key={template.id} className="p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-[var(--gray-12)] truncate">
                      {template.name}
                    </p>
                    <Badge color={template.is_active ? 'green' : 'gray'}>
                      {template.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                  </div>
                  <p className="text-xs text-[var(--gray-9)] mt-0.5">
                    {template.sub_event_id
                      ? subEventMap.get(template.sub_event_id) || 'Unknown sub-event'
                      : 'Default (all sub-events)'}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {/* Active toggle */}
                  <button
                    onClick={() => handleToggleActive(template)}
                    className="relative inline-flex items-center rounded-full transition-colors cursor-pointer"
                    style={{
                      width: 36,
                      height: 20,
                      backgroundColor: template.is_active ? 'var(--accent-9)' : 'var(--gray-6)',
                    }}
                    aria-label={template.is_active ? 'Deactivate' : 'Activate'}
                  >
                    <span
                      className="inline-block rounded-full bg-white"
                      style={{
                        width: 14,
                        height: 14,
                        transform: `translateX(${template.is_active ? 18 : 3}px)`,
                        transition: 'transform 150ms ease',
                      }}
                    />
                  </button>

                  {/* Edit */}
                  <button
                    onClick={() => openEdit(template)}
                    className="text-[var(--gray-9)] hover:text-[var(--gray-12)] cursor-pointer"
                    aria-label="Edit template"
                  >
                    <PencilIcon className="w-4 h-4" />
                  </button>

                  {/* Duplicate */}
                  <button
                    onClick={() => handleDuplicate(template)}
                    disabled={duplicatingId === template.id}
                    className="text-[var(--gray-9)] hover:text-[var(--gray-12)] cursor-pointer disabled:opacity-50"
                    aria-label="Duplicate template"
                  >
                    <DocumentDuplicateIcon className="w-4 h-4" />
                  </button>

                  {/* Delete */}
                  <button
                    onClick={() => setDeleteTarget(template)}
                    className="text-[var(--gray-9)] hover:text-red-600 cursor-pointer"
                    aria-label="Delete template"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Editor modal */}
      <Modal
        isOpen={editorOpen}
        onClose={handleEditorClose}
        title={editingTemplate ? `Edit ${CHANNELS.find(c => c.id === activeChannel)?.label} Template` : `Create ${CHANNELS.find(c => c.id === activeChannel)?.label} Template`}
        size="xl"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="soft" onClick={handleEditorClose} disabled={editorSaving}>
              Cancel
            </Button>
            <Button onClick={handleEditorSaveClick} disabled={editorSaving}>
              {editorSaving ? 'Saving...' : 'Save Template'}
            </Button>
          </div>
        }
      >
        {editorOpen && (
          <div className="space-y-3">
            {/* Sub-event selector — always shown when sub-events exist */}
            {subEvents.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">
                  Sub-Event
                </label>
                <select
                  value={createSubEventId || ''}
                  onChange={e => setCreateSubEventId(e.target.value || null)}
                  className="w-full px-2 py-1.5 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
                >
                  <option value="">Default (all sub-events)</option>
                  {subEvents.map(se => (
                    <option key={se.id} value={se.id}>
                      {se.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <Suspense
              fallback={
                <div className="flex items-center justify-center py-12">
                  <p className="text-sm text-[var(--gray-9)]">Loading editor...</p>
                </div>
              }
            >
              {renderEditor()}
            </Suspense>
          </div>
        )}
      </Modal>

      {/* Delete confirmation modal */}
      <Modal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete Template"
        footer={
          deleteTarget && (
            <div className="flex justify-end gap-2">
              <Button variant="soft" onClick={() => setDeleteTarget(null)} disabled={deleting}>
                Cancel
              </Button>
              <Button color="red" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete'}
              </Button>
            </div>
          )
        }
      >
        {deleteTarget && (
          <p className="text-sm text-[var(--gray-12)]">
            Are you sure you want to delete the template{' '}
            <span className="font-medium">{deleteTarget.name}</span>? This action cannot be
            undone.
          </p>
        )}
      </Modal>
    </div>
  );
}
