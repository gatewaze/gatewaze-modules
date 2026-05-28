import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, Card, Modal } from '@/components/ui';
import RichTextEditor from '@/components/ui/RichTextEditor';
import {
  PlusIcon,
  PencilIcon,
  TrashIcon,
  Bars3Icon,
  CheckIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { normalizeOptions, type NormalizedOption } from './utils/inviteQuestionOptions';

interface InviteQuestion {
  id: string;
  event_id: string;
  question_text: string;
  question_type: 'select' | 'multi_select' | 'text' | 'yes_no';
  // Stored as a jsonb array. Legacy rows hold strings; new rows hold
  // { label, description? } objects. Normalize via normalizeOptions().
  options: Array<string | { label: string; description?: string }> | null;
  is_required: boolean;
  applies_to: 'all' | 'accepted_only';
  sort_order: number;
}

interface QuestionConfigPanelProps {
  eventUuid: string;
}

const QUESTION_TYPES = [
  { value: 'select', label: 'Single Select' },
  { value: 'multi_select', label: 'Multi Select' },
  { value: 'text', label: 'Free Text' },
  { value: 'yes_no', label: 'Yes / No' },
];

interface SubEvent {
  id: string;
  name: string;
}

export function QuestionConfigPanel({ eventUuid }: QuestionConfigPanelProps) {
  const [questions, setQuestions] = useState<InviteQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<InviteQuestion | null>(null);

  // Sub-events
  const [subEvents, setSubEvents] = useState<SubEvent[]>([]);
  const [activeSubEvent, setActiveSubEvent] = useState<string | null>(null); // null = parent event (no sub-events)

  // Form state
  const [questionText, setQuestionText] = useState('');
  const [questionType, setQuestionType] = useState<string>('select');
  // Each option carries a label and an optional rich-HTML description.
  const [options, setOptions] = useState<NormalizedOption[]>([{ label: '' }]);
  const [isRequired, setIsRequired] = useState(false);
  const [appliesTo, setAppliesTo] = useState<string>('accepted_only');
  const [formSubEventId, setFormSubEventId] = useState<string>('');
  const [saving, setSaving] = useState(false);

  // Load sub-events
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('invite_sub_events')
        .select('id, name')
        .eq('event_id', eventUuid)
        .order('sort_order');
      setSubEvents(data || []);
      if (data && data.length > 0) {
        setActiveSubEvent(data[0].id);
      }
    })();
  }, [eventUuid]);

  const loadQuestions = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase
        .from('invite_questions')
        .select('*')
        .eq('event_id', eventUuid)
        .order('sort_order');

      // Load all questions for this event (sub-event filtering is visual only)

      const { data, error } = await query;

      if (error) throw error;
      setQuestions(data || []);
    } catch (error) {
      console.error('Error loading questions:', error);
      toast.error('Failed to load questions');
    } finally {
      setLoading(false);
    }
  }, [eventUuid, activeSubEvent, subEvents.length]);

  useEffect(() => {
    loadQuestions();
  }, [loadQuestions]);

  const resetForm = () => {
    setQuestionText('');
    setQuestionType('select');
    setOptions([{ label: '' }]);
    setIsRequired(false);
    setAppliesTo('accepted_only');
    setFormSubEventId(activeSubEvent || '');
    setEditing(null);
  };

  const openEdit = (q: InviteQuestion) => {
    setEditing(q);
    setQuestionText(q.question_text);
    setQuestionType(q.question_type);
    const normalized = normalizeOptions(q.options);
    setOptions(normalized.length > 0 ? normalized : [{ label: '' }]);
    setIsRequired(q.is_required);
    setAppliesTo(q.applies_to);
    setFormSubEventId((q as any).sub_event_id || '');
    setShowForm(true);
  };

  const openCreate = () => {
    resetForm();
    setShowForm(true);
  };

  const handleSave = async () => {
    // Question text may now contain HTML — strip tags for the empty check
    const plainText = questionText.replace(/<[^>]*>/g, '').trim();
    if (!plainText) {
      toast.error('Question text is required');
      return;
    }

    // Clean each option: trim label, drop empty descriptions, filter
    // out options with no label.
    const cleanOptions = (questionType === 'select' || questionType === 'multi_select')
      ? options
          .map(o => ({
            label: o.label.trim(),
            description: o.description?.trim() || undefined,
          }))
          .filter(o => o.label !== '')
      : null;

    if ((questionType === 'select' || questionType === 'multi_select') && (!cleanOptions || cleanOptions.length < 2)) {
      toast.error('Select questions need at least 2 options');
      return;
    }

    setSaving(true);
    try {
      const data = {
        event_id: eventUuid,
        sub_event_id: formSubEventId || null,
        question_text: questionText.trim(),  // HTML — sanitized on render
        question_type: questionType,
        options: cleanOptions,
        is_required: isRequired,
        applies_to: appliesTo,
        sort_order: editing ? editing.sort_order : questions.length,
      };

      if (editing) {
        const { error } = await supabase
          .from('invite_questions')
          .update(data)
          .eq('id', editing.id);
        if (error) throw error;
        toast.success('Question updated');
      } else {
        const { error } = await supabase
          .from('invite_questions')
          .insert(data);
        if (error) throw error;
        toast.success('Question added');
      }

      setShowForm(false);
      resetForm();
      loadQuestions();
    } catch (error) {
      console.error('Error saving question:', error);
      toast.error('Failed to save question');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this question? Existing responses will also be deleted.')) return;

    try {
      const { error } = await supabase
        .from('invite_questions')
        .delete()
        .eq('id', id);
      if (error) throw error;
      toast.success('Question deleted');
      loadQuestions();
    } catch (error) {
      console.error('Error deleting question:', error);
      toast.error('Failed to delete question');
    }
  };

  const handleMoveUp = async (index: number) => {
    if (index === 0) return;
    const updated = [...questions];
    [updated[index - 1], updated[index]] = [updated[index], updated[index - 1]];
    for (let i = 0; i < updated.length; i++) {
      await supabase.from('invite_questions').update({ sort_order: i }).eq('id', updated[i].id);
    }
    loadQuestions();
  };

  const handleMoveDown = async (index: number) => {
    if (index === questions.length - 1) return;
    const updated = [...questions];
    [updated[index], updated[index + 1]] = [updated[index + 1], updated[index]];
    for (let i = 0; i < updated.length; i++) {
      await supabase.from('invite_questions').update({ sort_order: i }).eq('id', updated[i].id);
    }
    loadQuestions();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--gray-12)]">Follow-up Questions</h3>
        <Button variant="soft" size="1" onClick={openCreate}>
          <PlusIcon className="w-4 h-4 mr-1" />
          Add Question
        </Button>
      </div>


      {loading ? (
        <p className="text-sm text-[var(--gray-9)]">Loading questions...</p>
      ) : questions.length === 0 ? (
        <Card className="p-4">
          <p className="text-sm text-[var(--gray-9)] text-center">
            No follow-up questions configured. Add questions like "Meal preference" or "Dietary requirements" that will be shown during RSVP.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {questions.map((q, i) => (
            <Card key={q.id} className="p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2 flex-1">
                  <div className="flex flex-col gap-0.5 mt-1">
                    <button
                      onClick={() => handleMoveUp(i)}
                      disabled={i === 0}
                      className="text-[var(--gray-9)] hover:text-[var(--gray-12)] disabled:opacity-30 cursor-pointer disabled:cursor-default"
                    >
                      <Bars3Icon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex-1">
                    <div
                      className="text-sm font-medium text-[var(--gray-12)] [&_p]:m-0 [&_h1]:m-0 [&_h2]:m-0 [&_h3]:m-0"
                      dangerouslySetInnerHTML={{ __html: q.question_text || '' }}
                    />
                    <div className="flex gap-2 mt-1">
                      <span className="text-xs text-[var(--gray-9)]">
                        {QUESTION_TYPES.find(t => t.value === q.question_type)?.label}
                      </span>
                      {q.is_required && (
                        <span className="text-xs text-red-600 font-medium">Required</span>
                      )}
                      <span className="text-xs text-[var(--gray-9)]">
                        {q.applies_to === 'accepted_only' ? 'Attending only' : 'All invitees'}
                      </span>
                      {subEvents.length > 0 && (
                        <span className="text-xs text-[var(--accent-9)] font-medium">
                          {(q as any).sub_event_id
                            ? subEvents.find(se => se.id === (q as any).sub_event_id)?.name || 'Sub-event'
                            : 'All sub-events'}
                        </span>
                      )}
                    </div>
                    {q.options && q.options.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {normalizeOptions(q.options).map((opt, j) => (
                          <span
                            key={j}
                            className="text-xs bg-[var(--gray-3)] text-[var(--gray-11)] px-2 py-0.5 rounded"
                            title={opt.description ? opt.description.replace(/<[^>]*>/g, '') : undefined}
                          >
                            {opt.label}
                            {opt.description && <span className="ml-1 text-[var(--gray-9)]">·</span>}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => openEdit(q)} className="text-[var(--gray-9)] hover:text-[var(--gray-12)] cursor-pointer">
                    <PencilIcon className="w-4 h-4" />
                  </button>
                  <button onClick={() => handleDelete(q.id)} className="text-[var(--gray-9)] hover:text-red-600 cursor-pointer">
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Add/Edit Question Modal */}
      <Modal
        isOpen={showForm}
        onClose={() => { setShowForm(false); resetForm(); }}
        title={editing ? 'Edit Question' : 'Add Question'}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="soft" onClick={() => { setShowForm(false); resetForm(); }} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : editing ? 'Update' : 'Add Question'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Question</label>
            <RichTextEditor
              content={questionText}
              onChange={setQuestionText}
              placeholder="e.g. What is your meal preference?"
            />
          </div>

          {subEvents.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Applies to sub-event</label>
              <select
                value={formSubEventId}
                onChange={e => setFormSubEventId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
              >
                <option value="">All (no specific sub-event)</option>
                {subEvents.map(se => (
                  <option key={se.id} value={se.id}>{se.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Type</label>
            <select
              value={questionType}
              onChange={e => setQuestionType(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
            >
              {QUESTION_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {(questionType === 'select' || questionType === 'multi_select') && (
            <div>
              <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Options</label>
              <p className="text-xs text-[var(--gray-9)] mb-2">
                Each option has a label (the chosen answer) and an optional description shown below the label — use the description for menu item details, dietary notes, etc.
              </p>
              <div className="space-y-3">
                {options.map((opt, i) => (
                  <div key={i} className="rounded-md border border-[var(--gray-6)] p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={opt.label}
                        onChange={e => {
                          const updated = [...options];
                          updated[i] = { ...updated[i], label: e.target.value };
                          setOptions(updated);
                        }}
                        placeholder={`Option ${i + 1}`}
                        className="flex-1 px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
                      />
                      {options.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setOptions(options.filter((_, j) => j !== i))}
                          className="text-[var(--gray-9)] hover:text-red-600 cursor-pointer"
                          aria-label="Remove option"
                        >
                          <XMarkIcon className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    <div>
                      <label className="block text-xs text-[var(--gray-9)] mb-1">Description (optional)</label>
                      <RichTextEditor
                        content={opt.description || ''}
                        onChange={(html: string) => {
                          const updated = [...options];
                          updated[i] = { ...updated[i], description: html };
                          setOptions(updated);
                        }}
                        placeholder="e.g. Slow-roasted with garlic & rosemary"
                      />
                    </div>
                  </div>
                ))}
                <Button variant="soft" size="1" onClick={() => setOptions([...options, { label: '' }])}>
                  <PlusIcon className="w-3 h-3 mr-1" />
                  Add Option
                </Button>
              </div>
            </div>
          )}

          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm text-[var(--gray-12)] cursor-pointer">
              <input
                type="checkbox"
                checked={isRequired}
                onChange={e => setIsRequired(e.target.checked)}
                className="rounded"
              />
              Required
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Show to</label>
            <select
              value={appliesTo}
              onChange={e => setAppliesTo(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
            >
              <option value="accepted_only">Attending guests only</option>
              <option value="all">All invitees</option>
            </select>
          </div>

        </div>
      </Modal>
    </div>
  );
}
