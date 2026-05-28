import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, Modal, Badge } from '@/components/ui';
import { toast } from 'sonner';
import DOMPurify from 'isomorphic-dompurify';
import { normalizeOptions } from './utils/inviteQuestionOptions';

function safeHtml(html: string | null | undefined): string {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'span'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  });
}

export interface AdminResponseQuestion {
  id: string;
  event_id: string;
  sub_event_id: string | null;
  question_text: string;
  question_type: 'select' | 'multi_select' | 'text' | 'yes_no';
  // Stored as a jsonb array. Legacy rows hold strings; new rows hold
  // { label, description? } objects. Normalize via normalizeOptions().
  options: Array<string | { label: string; description?: string }> | null;
  is_required: boolean;
  applies_to: 'all' | 'accepted_only';
  sort_order: number;
}

export interface AdminResponseMemberEvent {
  member_event_id: string;
  event_id: string;
  sub_event_id: string | null;
  sub_event_name: string | null;
  rsvp_status: string;
}

interface AdminResponseModalProps {
  isOpen: boolean;
  onClose: () => void;
  memberName: string;
  memberEvents: AdminResponseMemberEvent[];
  questions: AdminResponseQuestion[];
  /** keyed by `${member_event_id}:${question_id}` → answer (JSON value) */
  existingAnswers: Map<string, unknown>;
  onSaved: () => void;
}

/**
 * Admin-side responder for follow-up questions. Used when a guest RSVPs
 * manually (e.g. by phone) and an admin is filling in their answers on their
 * behalf.
 *
 * Shows one section per accepted member-event, listing only the questions
 * applicable to that sub-event (and any event-wide questions). Save performs
 * upserts against invite_responses.
 */
export function AdminResponseModal({
  isOpen,
  onClose,
  memberName,
  memberEvents,
  questions,
  existingAnswers,
  onSaved,
}: AdminResponseModalProps) {
  // draft state: `${member_event_id}:${question_id}` → answer
  const [draft, setDraft] = useState<Map<string, unknown>>(new Map());
  const [saving, setSaving] = useState(false);

  // Hydrate draft from existing answers whenever the modal is (re)opened.
  useEffect(() => {
    if (!isOpen) return;
    setDraft(new Map(existingAnswers));
  }, [isOpen, existingAnswers]);

  // Only include accepted member-events, since questions are gated by
  // acceptance.
  const acceptedEvents = useMemo(
    () => memberEvents.filter(me => me.rsvp_status === 'accepted'),
    [memberEvents],
  );

  const questionsForEvent = (subEventId: string | null): AdminResponseQuestion[] => {
    return questions
      .filter(q => q.sub_event_id === subEventId || q.sub_event_id === null)
      .sort((a, b) => a.sort_order - b.sort_order);
  };

  const getDraftValue = (memberEventId: string, questionId: string) => {
    return draft.get(`${memberEventId}:${questionId}`);
  };

  const setDraftValue = (memberEventId: string, questionId: string, value: unknown) => {
    setDraft(prev => {
      const next = new Map(prev);
      next.set(`${memberEventId}:${questionId}`, value);
      return next;
    });
  };

  const handleSave = async () => {
    // Validate required questions across the visible events
    for (const me of acceptedEvents) {
      const qs = questionsForEvent(me.sub_event_id);
      for (const q of qs) {
        if (!q.is_required) continue;
        const v = getDraftValue(me.member_event_id, q.id);
        const empty =
          v === undefined ||
          v === null ||
          v === '' ||
          (Array.isArray(v) && v.length === 0);
        if (empty) {
          // Strip HTML for the error message
          const plainQuestion = q.question_text.replace(/<[^>]*>/g, '').trim();
          toast.error(`"${plainQuestion}" is required`);
          return;
        }
      }
    }

    setSaving(true);
    try {
      // Build upsert payload. We only insert/update rows that have a value;
      // an answer that was cleared gets deleted explicitly.
      const upserts: Array<{ party_member_event_id: string; question_id: string; answer: unknown }> = [];
      const deletes: Array<{ party_member_event_id: string; question_id: string }> = [];

      for (const [key, value] of draft.entries()) {
        const [member_event_id, question_id] = key.split(':');
        const empty =
          value === undefined ||
          value === null ||
          value === '' ||
          (Array.isArray(value) && value.length === 0);
        if (empty) {
          if (existingAnswers.has(key)) {
            deletes.push({ party_member_event_id: member_event_id, question_id });
          }
        } else {
          upserts.push({ party_member_event_id: member_event_id, question_id, answer: value });
        }
      }

      if (upserts.length > 0) {
        const { error } = await supabase
          .from('invite_responses')
          .upsert(upserts, { onConflict: 'party_member_event_id,question_id' });
        if (error) throw error;
      }

      for (const d of deletes) {
        const { error } = await supabase
          .from('invite_responses')
          .delete()
          .eq('party_member_event_id', d.party_member_event_id)
          .eq('question_id', d.question_id);
        if (error) throw error;
      }

      // Touch the member_event responded_at so the party status summary
      // picks up the fact that a response has been recorded.
      const nowIso = new Date().toISOString();
      const memberEventIds = Array.from(new Set([
        ...upserts.map(u => u.party_member_event_id),
        ...deletes.map(d => d.party_member_event_id),
      ]));
      if (memberEventIds.length > 0) {
        await supabase
          .from('invite_party_member_events')
          .update({ responded_at: nowIso })
          .in('id', memberEventIds);
      }

      toast.success('Responses saved');
      onSaved();
      onClose();
    } catch (err: any) {
      console.error('Failed to save responses:', err);
      toast.error(`Failed to save responses: ${err.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  const renderField = (q: AdminResponseQuestion, memberEventId: string) => {
    const value = getDraftValue(memberEventId, q.id);
    const baseClass =
      'w-full px-3 py-1.5 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]';

    switch (q.question_type) {
      case 'select':
        return (
          <div className="space-y-2">
            {normalizeOptions(q.options).map(opt => {
              const sel = (value as string) === opt.label;
              const inputId = `${memberEventId}:${q.id}:${opt.label}`;
              return (
                <label
                  key={opt.label}
                  htmlFor={inputId}
                  className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                    sel
                      ? 'border-[var(--accent-9)] bg-[var(--accent-3)]'
                      : 'border-[var(--gray-6)] hover:bg-[var(--gray-3)]'
                  }`}
                >
                  <input
                    id={inputId}
                    type="radio"
                    name={`${memberEventId}:${q.id}`}
                    checked={sel}
                    onChange={() => setDraftValue(memberEventId, q.id, opt.label)}
                    className="mt-1 cursor-pointer"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-[var(--gray-12)]">{opt.label}</div>
                    {opt.description && (
                      <div
                        className="text-xs text-[var(--gray-11)] mt-1 [&_p]:m-0 [&_p+p]:mt-1 [&_a]:underline"
                        dangerouslySetInnerHTML={{ __html: safeHtml(opt.description) }}
                      />
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        );
      case 'multi_select': {
        const arr = Array.isArray(value) ? (value as string[]) : [];
        return (
          <div className="space-y-2">
            {normalizeOptions(q.options).map(opt => {
              const checked = arr.includes(opt.label);
              const inputId = `${memberEventId}:${q.id}:${opt.label}`;
              return (
                <label
                  key={opt.label}
                  htmlFor={inputId}
                  className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                    checked
                      ? 'border-[var(--accent-9)] bg-[var(--accent-3)]'
                      : 'border-[var(--gray-6)] hover:bg-[var(--gray-3)]'
                  }`}
                >
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={checked}
                    onChange={e => {
                      const next = e.target.checked
                        ? [...arr, opt.label]
                        : arr.filter(x => x !== opt.label);
                      setDraftValue(memberEventId, q.id, next);
                    }}
                    className="mt-1 cursor-pointer"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-[var(--gray-12)]">{opt.label}</div>
                    {opt.description && (
                      <div
                        className="text-xs text-[var(--gray-11)] mt-1 [&_p]:m-0 [&_p+p]:mt-1 [&_a]:underline"
                        dangerouslySetInnerHTML={{ __html: safeHtml(opt.description) }}
                      />
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        );
      }
      case 'yes_no':
        return (
          <div className="flex gap-2">
            {['yes', 'no'].map(v => (
              <button
                key={v}
                type="button"
                onClick={() => setDraftValue(memberEventId, q.id, v)}
                className={`px-3 py-1.5 text-sm rounded-md border cursor-pointer ${
                  value === v
                    ? 'bg-[var(--accent-9)] text-white border-[var(--accent-9)]'
                    : 'bg-[var(--color-background)] text-[var(--gray-12)] border-[var(--gray-6)] hover:bg-[var(--gray-3)]'
                }`}
              >
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        );
      case 'text':
        return (
          <textarea
            value={(value as string) || ''}
            onChange={e => setDraftValue(memberEventId, q.id, e.target.value)}
            rows={2}
            className={baseClass + ' resize-y'}
          />
        );
      default:
        return null;
    }
  };

  const totalQuestions = acceptedEvents.reduce((sum, me) => sum + questionsForEvent(me.sub_event_id).length, 0);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Respond as ${memberName}`}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="soft" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || totalQuestions === 0}>
            {saving ? 'Saving...' : 'Save Responses'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {acceptedEvents.length === 0 ? (
          <p className="text-sm text-[var(--gray-9)] text-center py-6">
            {memberName} has no accepted sub-events. Change their RSVP to &ldquo;Accepted&rdquo; before answering follow-up questions.
          </p>
        ) : totalQuestions === 0 ? (
          <p className="text-sm text-[var(--gray-9)] text-center py-6">
            No follow-up questions configured for their accepted sub-events.
          </p>
        ) : (
          acceptedEvents.map(me => {
            const qs = questionsForEvent(me.sub_event_id);
            if (qs.length === 0) return null;
            return (
              <div key={me.member_event_id} className="space-y-3">
                <div className="flex items-center gap-2 pb-1 border-b border-[var(--gray-6)]">
                  <h4 className="text-sm font-semibold text-[var(--gray-12)]">
                    {me.sub_event_name || 'Event'}
                  </h4>
                  <Badge color="green">Accepted</Badge>
                </div>
                {qs.map(q => (
                  <div key={q.id} className="space-y-2">
                    <div className="text-sm font-medium text-[var(--gray-12)] [&_p]:m-0 [&_p+p]:mt-1 [&_h1]:m-0 [&_h2]:m-0 [&_h3]:m-0">
                      <span dangerouslySetInnerHTML={{ __html: safeHtml(q.question_text) }} />
                      {q.is_required && <span className="text-red-500 ml-1">*</span>}
                    </div>
                    {renderField(q, me.member_event_id)}
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}
