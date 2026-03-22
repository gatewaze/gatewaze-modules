import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  PlusIcon,
  TrashIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  EyeIcon,
  ArrowDownTrayIcon,
  ClipboardDocumentListIcon,
  CodeBracketIcon,
  TableCellsIcon,
  PencilSquareIcon,
  ClipboardIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  createColumnHelper,
  SortingState,
} from '@tanstack/react-table';
import {
  Card,
  Button,
  Badge,
  Modal,
  Switch,
  Pagination,
  PaginationFirst,
  PaginationLast,
  PaginationNext,
  PaginationPrevious,
  PaginationItems,
} from '@/components/ui';
import { Input } from '@/components/ui/Form';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { DataTable } from '@/components/shared/table/DataTable';
import { RowActions } from '@/components/shared/table/RowActions';
import { supabase } from '@/lib/supabase';

const PAGE_SIZE = 25;

type ViewMode = 'builder' | 'submissions' | 'embed';

interface FormField {
  id: string;
  type: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  options?: string[];
}

interface FormData {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  fields: FormField[];
  thank_you_message: string;
  is_active: boolean;
  settings: Record<string, any>;
  created_at: string;
  updated_at: string;
}

interface Submission {
  id: string;
  form_id: string;
  person_id: string | null;
  responses: Record<string, any>;
  metadata: Record<string, any>;
  created_at: string;
  person?: { email: string; attributes: Record<string, any> } | null;
}

const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'email', label: 'Email' },
  { value: 'textarea', label: 'Text Area' },
  { value: 'number', label: 'Number' },
  { value: 'tel', label: 'Phone' },
  { value: 'url', label: 'URL' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Dropdown' },
  { value: 'radio', label: 'Radio Buttons' },
  { value: 'checkbox', label: 'Checkboxes' },
];

function timeAgo(dateString: string | undefined): string {
  if (!dateString) return '-';
  const seconds = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
  const intervals: [string, number][] = [
    ['year', 31536000], ['month', 2592000], ['week', 604800],
    ['day', 86400], ['hour', 3600], ['minute', 60],
  ];
  for (const [unit, secs] of intervals) {
    const interval = Math.floor(seconds / secs);
    if (interval >= 1) return `${interval} ${unit}${interval === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

function formatTimestamp(dateString: string | undefined): string {
  if (!dateString) return '';
  return new Date(dateString).toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

const submissionColumnHelper = createColumnHelper<Submission>();

export default function FormDetailPage() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();

  const [form, setForm] = useState<FormData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('builder');

  // Builder state
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<FormField[]>([]);
  const [thankYouMessage, setThankYouMessage] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [submitButtonText, setSubmitButtonText] = useState('Submit');

  // Submissions state
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [submissionsLoading, setSubmissionsLoading] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'created_at', desc: true }]);
  const [selectedSubmission, setSelectedSubmission] = useState<Submission | null>(null);
  const [viewModalOpen, setViewModalOpen] = useState(false);

  // Editing field
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);

  const loadForm = useCallback(async () => {
    if (!formId) return;
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('forms')
        .select('*')
        .eq('id', formId)
        .single();

      if (error || !data) {
        toast.error('Form not found');
        navigate('/forms');
        return;
      }

      setForm(data);
      setName(data.name);
      setSlug(data.slug);
      setDescription(data.description || '');
      setFields(data.fields || []);
      setThankYouMessage(data.thank_you_message || 'Thank you for your submission!');
      setIsActive(data.is_active);
      setSubmitButtonText(data.settings?.submitButtonText || 'Submit');
    } finally {
      setLoading(false);
    }
  }, [formId, navigate]);

  const loadSubmissions = useCallback(async () => {
    if (!formId) return;
    try {
      setSubmissionsLoading(true);
      const { data, error } = await supabase
        .from('forms_submissions')
        .select('*, person:people(email, attributes)')
        .eq('form_id', formId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching submissions:', error);
        toast.error('Failed to load submissions');
        return;
      }

      setSubmissions((data || []).map((s: any) => ({
        ...s,
        person: Array.isArray(s.person) ? s.person[0] || null : s.person,
      })));
    } finally {
      setSubmissionsLoading(false);
    }
  }, [formId]);

  useEffect(() => {
    loadForm();
  }, [loadForm]);

  useEffect(() => {
    if (viewMode === 'submissions') loadSubmissions();
  }, [viewMode, loadSubmissions]);

  const handleSave = async () => {
    if (!formId) return;
    try {
      setSaving(true);
      const { error } = await supabase
        .from('forms')
        .update({
          name,
          slug,
          description: description || null,
          fields,
          thank_you_message: thankYouMessage,
          is_active: isActive,
          settings: { submitButtonText },
        })
        .eq('id', formId);

      if (error) {
        if (error.code === '23505') {
          toast.error('A form with this slug already exists');
        } else {
          toast.error('Failed to save form');
        }
        return;
      }

      toast.success('Form saved');
      loadForm();
    } finally {
      setSaving(false);
    }
  };

  // Field management
  const addField = () => {
    const newField: FormField = {
      id: 'field_' + Date.now().toString(36),
      type: 'text',
      label: 'New Field',
      placeholder: '',
      required: false,
    };
    setFields([...fields, newField]);
    setEditingFieldId(newField.id);
  };

  const updateField = (id: string, updates: Partial<FormField>) => {
    setFields(fields.map(f => f.id === id ? { ...f, ...updates } : f));
  };

  const removeField = (id: string) => {
    setFields(fields.filter(f => f.id !== id));
    if (editingFieldId === id) setEditingFieldId(null);
  };

  const moveField = (index: number, direction: -1 | 1) => {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= fields.length) return;
    const newFields = [...fields];
    [newFields[index], newFields[newIndex]] = [newFields[newIndex], newFields[index]];
    setFields(newFields);
  };

  // Submissions table columns
  const submissionColumns = useMemo(() => {
    const cols = [
      submissionColumnHelper.display({
        id: 'email',
        header: 'Email',
        cell: (info) => {
          const sub = info.row.original;
          const emailField = fields.find(f => f.type === 'email');
          const email = emailField ? sub.responses[emailField.id] : sub.person?.email || '-';
          return <div className="text-sm text-[var(--gray-12)] max-w-xs truncate">{email}</div>;
        },
      }),
      submissionColumnHelper.display({
        id: 'person',
        header: 'Person',
        cell: (info) => {
          const sub = info.row.original;
          if (!sub.person) return <span className="text-sm text-[var(--gray-11)]">-</span>;
          const name = [sub.person.attributes?.first_name, sub.person.attributes?.last_name].filter(Boolean).join(' ');
          return <div className="text-sm text-[var(--gray-12)]">{name || sub.person.email}</div>;
        },
      }),
      submissionColumnHelper.accessor('created_at', {
        header: 'Submitted',
        cell: (info) => (
          <div className="text-sm text-[var(--gray-11)] whitespace-nowrap" title={formatTimestamp(info.getValue())}>
            {timeAgo(info.getValue())}
          </div>
        ),
      }),
      submissionColumnHelper.display({
        id: 'source',
        header: 'Source',
        cell: (info) => (
          <Badge color="neutral">
            {info.row.original.metadata?.source || 'direct'}
          </Badge>
        ),
      }),
      submissionColumnHelper.display({
        id: 'actions',
        header: '',
        cell: (info) => (
          <RowActions
            actions={[
              { label: 'View', icon: <EyeIcon className="size-4" />, onClick: () => { setSelectedSubmission(info.row.original); setViewModalOpen(true); } },
            ]}
          />
        ),
      }),
    ];
    return cols;
  }, [fields]);

  const submissionsTable = useReactTable({
    data: submissions,
    columns: submissionColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: PAGE_SIZE } },
  });

  const handleExportCSV = () => {
    if (submissions.length === 0) {
      toast.error('No submissions to export');
      return;
    }

    const allFieldIds = fields.map(f => f.id);
    const headers = ['submission_id', 'email', 'person_id', 'source', 'submitted_at', ...fields.map(f => f.label)];
    const rows = submissions.map(s => {
      const emailField = fields.find(f => f.type === 'email');
      const email = emailField ? s.responses[emailField.id] : s.person?.email || '';
      return [
        s.id, email, s.person_id || '', s.metadata?.source || 'direct', s.created_at,
        ...allFieldIds.map(fid => {
          const val = s.responses[fid];
          if (Array.isArray(val)) return val.join('; ');
          return val?.toString() || '';
        }),
      ];
    });

    const escapeField = (f: string) => {
      if (f.includes(',') || f.includes('"') || f.includes('\n')) return `"${f.replace(/"/g, '""')}"`;
      return f;
    };

    const csv = [headers.map(escapeField).join(','), ...rows.map(r => r.map(escapeField).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `form-${slug}-submissions-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    toast.success(`Exported ${submissions.length} submissions`);
  };

  // Build embed code
  const portalDomain = import.meta.env.VITE_PORTAL_DOMAIN || '';
  const portalUrl = portalDomain ? `${window.location.protocol}//${portalDomain}` : '';
  const apiUrl = import.meta.env.VITE_API_URL || '';
  const embedCode = `<script src="${apiUrl}/api/modules/forms/${slug}/embed.js" data-gatewaze-form="${slug}" async></script>`;
  const portalLink = `${portalUrl}/forms/${slug}`;

  if (loading) {
    return (
      <Page title="Form">
        <div className="flex items-center justify-center h-64">
          <LoadingSpinner size="medium" />
        </div>
      </Page>
    );
  }

  return (
    <Page title={name || 'Form'}>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-4">
            <Button variant="outlined" onClick={() => navigate('/forms')} className="gap-2">
              <ArrowLeftIcon className="size-4" />
              Back
            </Button>
            <div>
              <h1 className="text-2xl font-semibold text-[var(--gray-12)]">{name}</h1>
              <p className="text-[var(--gray-11)] mt-1">/{slug}</p>
            </div>
          </div>
          <div className="flex gap-3 items-center">
            {viewMode === 'builder' && (
              <Button onClick={handleSave} disabled={saving} className="gap-2">
                {saving ? <ArrowPathIcon className="size-4 animate-spin" /> : null}
                Save Form
              </Button>
            )}
          </div>
        </div>

        {/* View Mode Toggle */}
        <div className="flex gap-2">
          <Button variant={viewMode === 'builder' ? 'filled' : 'outlined'} onClick={() => setViewMode('builder')} className="gap-2">
            <PencilSquareIcon className="size-4" />
            Builder
          </Button>
          <Button variant={viewMode === 'submissions' ? 'filled' : 'outlined'} onClick={() => setViewMode('submissions')} className="gap-2">
            <TableCellsIcon className="size-4" />
            Submissions ({submissions.length || '...'})
          </Button>
          <Button variant={viewMode === 'embed' ? 'filled' : 'outlined'} onClick={() => setViewMode('embed')} className="gap-2">
            <CodeBracketIcon className="size-4" />
            Share & Embed
          </Button>
        </div>

        {/* ================================================================= */}
        {/* BUILDER VIEW                                                       */}
        {/* ================================================================= */}
        {viewMode === 'builder' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Form Settings (left) */}
            <div className="lg:col-span-1 space-y-6">
              <Card variant="surface" className="p-6 space-y-4">
                <h3 className="text-sm font-medium text-[var(--gray-12)]">Form Settings</h3>

                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Name</label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Form name" />
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Slug</label>
                  <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="form-slug" />
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Description</label>
                  <textarea
                    className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-a8)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                    placeholder="Optional form description shown to users"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Thank You Message</label>
                  <textarea
                    className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-a8)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
                    value={thankYouMessage}
                    onChange={(e) => setThankYouMessage(e.target.value)}
                    rows={3}
                    placeholder="Message shown after submission"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Submit Button Text</label>
                  <Input value={submitButtonText} onChange={(e) => setSubmitButtonText(e.target.value)} placeholder="Submit" />
                </div>

                <Switch
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  label="Form is active"
                />
              </Card>
            </div>

            {/* Field Builder (right) */}
            <div className="lg:col-span-2 space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="text-sm font-medium text-[var(--gray-12)]">Fields ({fields.length})</h3>
                <Button onClick={addField} variant="outlined" className="gap-2">
                  <PlusIcon className="size-4" />
                  Add Field
                </Button>
              </div>

              {fields.length === 0 ? (
                <Card variant="surface" className="p-12 text-center">
                  <ClipboardDocumentListIcon className="mx-auto h-12 w-12 text-[var(--gray-a8)]" />
                  <h3 className="mt-2 text-sm font-medium text-[var(--gray-12)]">No fields yet</h3>
                  <p className="mt-1 text-sm text-[var(--gray-11)]">Add fields to build your form.</p>
                  <Button onClick={addField} className="mt-4 gap-2">
                    <PlusIcon className="size-4" />
                    Add First Field
                  </Button>
                </Card>
              ) : (
                <div className="space-y-3">
                  {fields.map((field, index) => (
                    <Card
                      key={field.id}
                      variant="surface"
                      className={`p-4 cursor-pointer transition-all ${editingFieldId === field.id ? 'ring-2 ring-[var(--accent-8)]' : ''}`}
                      onClick={() => setEditingFieldId(editingFieldId === field.id ? null : field.id)}
                    >
                      {/* Field header */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="flex flex-col gap-0.5">
                            <button
                              onClick={(e) => { e.stopPropagation(); moveField(index, -1); }}
                              disabled={index === 0}
                              className="p-0.5 text-[var(--gray-a8)] hover:text-[var(--gray-12)] disabled:opacity-30"
                            >
                              <ChevronUpIcon className="size-3" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); moveField(index, 1); }}
                              disabled={index === fields.length - 1}
                              className="p-0.5 text-[var(--gray-a8)] hover:text-[var(--gray-12)] disabled:opacity-30"
                            >
                              <ChevronDownIcon className="size-3" />
                            </button>
                          </div>
                          <div>
                            <span className="text-sm font-medium text-[var(--gray-12)]">{field.label}</span>
                            <div className="flex items-center gap-2 mt-0.5">
                              <Badge color="neutral">{FIELD_TYPES.find(t => t.value === field.type)?.label || field.type}</Badge>
                              {field.required && <Badge color="warning">Required</Badge>}
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); removeField(field.id); }}
                          className="p-1 text-[var(--gray-a8)] hover:text-red-500"
                        >
                          <TrashIcon className="size-4" />
                        </button>
                      </div>

                      {/* Field editor (expanded) */}
                      {editingFieldId === field.id && (
                        <div className="mt-4 pt-4 border-t border-[var(--gray-a6)] space-y-3" onClick={(e) => e.stopPropagation()}>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">Label</label>
                              <Input
                                value={field.label}
                                onChange={(e) => updateField(field.id, { label: e.target.value })}
                                placeholder="Field label"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">Type</label>
                              <select
                                value={field.type}
                                onChange={(e) => {
                                  const newType = e.target.value;
                                  const updates: Partial<FormField> = { type: newType };
                                  if (['select', 'radio', 'checkbox'].includes(newType) && !field.options?.length) {
                                    updates.options = ['Option 1', 'Option 2'];
                                  }
                                  updateField(field.id, updates);
                                }}
                                className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm text-[var(--gray-12)]"
                              >
                                {FIELD_TYPES.map(t => (
                                  <option key={t.value} value={t.value}>{t.label}</option>
                                ))}
                              </select>
                            </div>
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">Placeholder</label>
                            <Input
                              value={field.placeholder || ''}
                              onChange={(e) => updateField(field.id, { placeholder: e.target.value })}
                              placeholder="Placeholder text"
                            />
                          </div>

                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={field.required || false}
                              onChange={(e) => updateField(field.id, { required: e.target.checked })}
                              className="rounded"
                            />
                            <span className="text-sm text-[var(--gray-11)]">Required field</span>
                          </div>

                          {/* Options editor for select/radio/checkbox */}
                          {['select', 'radio', 'checkbox'].includes(field.type) && (
                            <div>
                              <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">Options</label>
                              <div className="space-y-2">
                                {(field.options || []).map((opt, optIdx) => (
                                  <div key={optIdx} className="flex gap-2">
                                    <Input
                                      value={opt}
                                      onChange={(e) => {
                                        const newOptions = [...(field.options || [])];
                                        newOptions[optIdx] = e.target.value;
                                        updateField(field.id, { options: newOptions });
                                      }}
                                      placeholder={`Option ${optIdx + 1}`}
                                    />
                                    <button
                                      onClick={() => {
                                        const newOptions = (field.options || []).filter((_, i) => i !== optIdx);
                                        updateField(field.id, { options: newOptions });
                                      }}
                                      className="p-2 text-[var(--gray-a8)] hover:text-red-500"
                                    >
                                      <TrashIcon className="size-4" />
                                    </button>
                                  </div>
                                ))}
                                <Button
                                  variant="outlined"
                                  onClick={() => updateField(field.id, { options: [...(field.options || []), `Option ${(field.options?.length || 0) + 1}`] })}
                                  className="gap-2 text-xs"
                                >
                                  <PlusIcon className="size-3" />
                                  Add Option
                                </Button>
                              </div>
                            </div>
                          )}

                          <div>
                            <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">Field ID</label>
                            <Input
                              value={field.id}
                              onChange={(e) => {
                                const newId = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
                                if (newId && !fields.some(f => f.id === newId && f.id !== field.id)) {
                                  const newFields = fields.map(f => f.id === field.id ? { ...f, id: newId } : f);
                                  setFields(newFields);
                                  setEditingFieldId(newId);
                                }
                              }}
                              placeholder="field_id"
                            />
                            <p className="text-xs text-[var(--gray-a8)] mt-1">Unique identifier used in API responses</p>
                          </div>
                        </div>
                      )}
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ================================================================= */}
        {/* SUBMISSIONS VIEW                                                   */}
        {/* ================================================================= */}
        {viewMode === 'submissions' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <div className="text-sm text-[var(--gray-11)]">
                {submissions.length} submission{submissions.length !== 1 ? 's' : ''}
              </div>
              <div className="flex gap-3">
                <Button onClick={handleExportCSV} variant="outlined" className="gap-2" disabled={submissions.length === 0}>
                  <ArrowDownTrayIcon className="size-4" />
                  Export CSV
                </Button>
                <Button onClick={loadSubmissions} variant="outlined" className="gap-2" disabled={submissionsLoading}>
                  <ArrowPathIcon className={`size-4 ${submissionsLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
              </div>
            </div>

            <Card className="overflow-hidden">
              <DataTable
                table={submissionsTable}
                loading={submissionsLoading}
                onRowDoubleClick={(sub) => { setSelectedSubmission(sub); setViewModalOpen(true); }}
              />

              {!submissionsLoading && submissionsTable.getRowModel().rows.length > 0 && (
                <div className="px-6 py-4 bg-[var(--gray-a3)] border-t border-[var(--gray-a6)]">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-[var(--gray-11)]">
                      Showing {submissionsTable.getState().pagination.pageIndex * PAGE_SIZE + 1} to{' '}
                      {Math.min((submissionsTable.getState().pagination.pageIndex + 1) * PAGE_SIZE, submissions.length)} of {submissions.length}
                    </div>
                    <Pagination
                      total={submissionsTable.getPageCount()}
                      value={submissionsTable.getState().pagination.pageIndex + 1}
                      onChange={(page) => submissionsTable.setPageIndex(page - 1)}
                    >
                      <PaginationFirst onClick={() => submissionsTable.setPageIndex(0)} disabled={!submissionsTable.getCanPreviousPage()} />
                      <PaginationPrevious onClick={() => submissionsTable.previousPage()} disabled={!submissionsTable.getCanPreviousPage()} />
                      <PaginationItems />
                      <PaginationNext onClick={() => submissionsTable.nextPage()} disabled={!submissionsTable.getCanNextPage()} />
                      <PaginationLast onClick={() => submissionsTable.setPageIndex(submissionsTable.getPageCount() - 1)} disabled={!submissionsTable.getCanNextPage()} />
                    </Pagination>
                  </div>
                </div>
              )}
            </Card>

            {/* View Submission Modal */}
            <Modal isOpen={viewModalOpen} onClose={() => setViewModalOpen(false)} title="Form Submission">
              {selectedSubmission && (
                <div className="space-y-6 max-h-[70vh] overflow-y-auto">
                  <div className="space-y-2 p-4 bg-[var(--gray-a3)] rounded-lg">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="font-medium text-[var(--gray-11)]">Person:</span>
                        <p className="text-[var(--gray-12)]">{selectedSubmission.person?.email || 'Anonymous'}</p>
                      </div>
                      <div>
                        <span className="font-medium text-[var(--gray-11)]">Submitted:</span>
                        <p className="text-[var(--gray-12)]">{formatTimestamp(selectedSubmission.created_at)}</p>
                      </div>
                      <div>
                        <span className="font-medium text-[var(--gray-11)]">Source:</span>
                        <p className="text-[var(--gray-12)]">{selectedSubmission.metadata?.source || 'direct'}</p>
                      </div>
                      {selectedSubmission.person_id && (
                        <div>
                          <span className="font-medium text-[var(--gray-11)]">Person ID:</span>
                          <p className="text-[var(--gray-12)] font-mono text-xs">{selectedSubmission.person_id}</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-[var(--gray-11)] mb-2">Responses</h4>
                    <div className="space-y-3">
                      {Object.entries(selectedSubmission.responses || {}).map(([key, value]) => {
                        const field = fields.find(f => f.id === key);
                        return (
                          <div key={key} className="p-3 border border-[var(--gray-a6)] rounded-lg">
                            <div className="text-sm font-medium text-[var(--gray-11)] mb-1">
                              {field?.label || key}
                            </div>
                            <div className="text-[var(--gray-12)]">
                              {Array.isArray(value)
                                ? value.join(', ')
                                : value?.toString() || '-'}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </Modal>
          </div>
        )}

        {/* ================================================================= */}
        {/* EMBED VIEW                                                         */}
        {/* ================================================================= */}
        {viewMode === 'embed' && (
          <div className="space-y-6">
            <Card variant="surface" className="p-6 space-y-4">
              <h3 className="text-lg font-medium text-[var(--gray-12)]">Portal Link</h3>
              <p className="text-sm text-[var(--gray-11)]">
                Share this link to let people fill out the form on your portal.
              </p>
              <div className="flex gap-2">
                <Input value={portalLink} readOnly className="font-mono text-sm" />
                <Button
                  variant="outlined"
                  onClick={() => { navigator.clipboard.writeText(portalLink); toast.success('Copied!'); }}
                  className="gap-2 shrink-0"
                >
                  <ClipboardIcon className="size-4" />
                  Copy
                </Button>
              </div>
            </Card>

            <Card variant="surface" className="p-6 space-y-4">
              <h3 className="text-lg font-medium text-[var(--gray-12)]">Embed Code</h3>
              <p className="text-sm text-[var(--gray-11)]">
                Add this code to any website to embed the form. When submitted, the form will be replaced with your thank you message.
              </p>
              <div className="relative">
                <pre className="p-4 bg-[var(--gray-a3)] rounded-lg text-sm font-mono text-[var(--gray-12)] overflow-x-auto whitespace-pre-wrap break-all">
                  {embedCode}
                </pre>
                <Button
                  variant="outlined"
                  onClick={() => { navigator.clipboard.writeText(embedCode); toast.success('Embed code copied!'); }}
                  className="absolute top-2 right-2 gap-2"
                >
                  <ClipboardIcon className="size-4" />
                  Copy
                </Button>
              </div>
            </Card>

            <Card variant="surface" className="p-6 space-y-4">
              <h3 className="text-lg font-medium text-[var(--gray-12)]">API Endpoint</h3>
              <p className="text-sm text-[var(--gray-11)]">
                Submit forms programmatically via the API.
              </p>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">GET Form Definition</label>
                  <pre className="p-3 bg-[var(--gray-a3)] rounded-lg text-sm font-mono text-[var(--gray-12)]">
                    GET {apiUrl}/api/modules/forms/{slug}
                  </pre>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">POST Submit Form</label>
                  <pre className="p-3 bg-[var(--gray-a3)] rounded-lg text-sm font-mono text-[var(--gray-12)] whitespace-pre-wrap">{`POST ${apiUrl}/api/modules/forms/${slug}/submit
Content-Type: application/json

{
  "responses": {
${fields.map(f => `    "${f.id}": "${f.type === 'checkbox' ? '["value1"]' : 'value'}"`).join(',\n')}
  },
  "source": "api"
}`}</pre>
                </div>
              </div>
            </Card>
          </div>
        )}
      </div>
    </Page>
  );
}
