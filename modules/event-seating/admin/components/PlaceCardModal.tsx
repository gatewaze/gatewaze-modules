import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { Button, Modal } from '@/components/ui';
import {
  getCourseQuestions,
  guessCourseQuestions,
  type CourseQuestion,
} from '../utils/cateringExport';
import {
  buildPlaceCards,
  defaultPlaceCardFields,
  findPlaceCardTemplate,
  getFontAssets,
  type PlaceCardTemplate,
} from '../utils/placeCards';
import { downloadPlaceCardPdf } from '../utils/placeCardPdf';
import type { Guest, SeatingAssignment, SeatingPlan, SeatingTable } from '../utils/seatingService';
import { PlaceCardTemplateEditor } from './PlaceCardTemplateEditor';

/**
 * Prints folded place-name cards for every seated guest: name on the outside
 * of the tent, their meal choices on the inside. One card per guest, in
 * table-and-seat order, sized for the 83 x 54mm A-cards that come flat with
 * a fold in the middle.
 */

interface Props {
  isOpen: boolean;
  onClose: () => void;
  plan: SeatingPlan;
  tables: SeatingTable[];
  assignments: SeatingAssignment[];
  guests: Guest[];
  subEventName: string;
}

export function PlaceCardModal({ isOpen, onClose, plan, tables, assignments, guests, subEventName }: Props) {
  const [questions, setQuestions] = useState<CourseQuestion[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [template, setTemplate] = useState<PlaceCardTemplate | null>(null);
  const [eventTitle, setEventTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [rows, matched, eventRes] = await Promise.all([
          getCourseQuestions(plan.event_id, plan.sub_event_id),
          findPlaceCardTemplate(plan.event_id, plan.sub_event_id),
          supabase.from('events').select('event_title').eq('id', plan.event_id).single(),
        ]);
        if (cancelled) return;
        setQuestions(rows);
        setSelected((current) => (current.length > 0 ? current : guessCourseQuestions(rows)));
        setTemplate(matched);
        setEventTitle(eventRes.data?.event_title || '');
      } catch (err) {
        console.error('[event-seating] Failed to load place-card data:', err);
        if (!cancelled) toast.error('Could not load the RSVP questions');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, plan.event_id, plan.sub_event_id]);

  const seatedCount = useMemo(
    () => assignments.filter((a) => a.party_member_id || a.guest_label).length,
    [assignments],
  );

  const toggle = (id: string, on: boolean) => {
    setSelected((current) =>
      on ? [...current, id] : current.filter((existing) => existing !== id));
  };

  const fields = template?.pdf_fields?.length ? template.pdf_fields : defaultPlaceCardFields();
  const hasInside = fields.some((f) => f.face === 'inside');

  const scopeLabel = template
    ? (template.sub_event_id
      ? `this template applies to ${subEventName || 'this sub-event'} only`
      : 'this template is the event default')
    : 'saving creates the event-default template';

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const cards = await buildPlaceCards({
        plan,
        tables,
        assignments,
        guests,
        questions,
        selectedQuestionIds: selected,
        eventTitle,
        subEventName,
      });

      if (cards.length === 0) {
        toast.error('Nobody is seated yet, so there are no place cards to print');
        return;
      }

      const fontAssets = await getFontAssets(plan.event_id);
      const stem = plan.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      await downloadPlaceCardPdf({
        fields,
        cards,
        fontAssets,
        filename: `${stem || 'seating'}-place-cards.pdf`,
      });

      const missing = cards.filter((c) => c.missingMeal).length;
      if (selected.length > 0 && missing > 0) {
        toast.warning(`Generated — ${missing} card${missing === 1 ? '' : 's'} had no meal selection recorded`);
      } else {
        toast.success(`${cards.length} place card${cards.length === 1 ? '' : 's'} generated`);
      }
      onClose();
    } catch (err) {
      console.error('[event-seating] Failed to generate place cards:', err);
      toast.error('Could not generate the place cards');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Place name cards"
        size="md"
        footer={
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-[var(--gray-9)]">
              {seatedCount} seated guest{seatedCount === 1 ? '' : 's'}
            </span>
            <div className="flex gap-2">
              <Button variant="soft" size="2" onClick={onClose}>Cancel</Button>
              <Button variant="outline" size="2" onClick={() => setEditorOpen(true)} disabled={loading}>
                Edit template
              </Button>
              <Button size="2" disabled={generating || loading || seatedCount === 0} onClick={handleGenerate}>
                {generating ? 'Generating…' : 'Generate PDF'}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-3 p-1">
          <p className="text-sm text-[var(--gray-11)]">
            One card per seated guest, in table and seat order, sized for the flat
            83 × 108mm cards that fold into an 83 × 54mm tent. The guest&apos;s name
            prints on the outside; the courses you tick below print on the inside.
          </p>

          {loading ? (
            <p className="py-4 text-center text-sm text-[var(--gray-9)]">Loading questions…</p>
          ) : questions.length === 0 ? (
            <p className="py-2 text-sm text-[var(--gray-9)]">
              This event has no RSVP questions, so the cards will carry names only.
            </p>
          ) : (
            <div className="space-y-1">
              {questions.map((q) => (
                <label
                  key={q.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-[var(--gray-6)] px-2 py-1.5 text-sm text-[var(--gray-12)] hover:border-[var(--accent-8)]"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(q.id)}
                    onChange={(e) => toggle(q.id, e.target.checked)}
                    className="cursor-pointer"
                  />
                  <span className="truncate">{q.label}</span>
                </label>
              ))}
            </div>
          )}

          {hasInside && (
            <p className="text-xs text-[var(--gray-9)]">
              The PDF alternates outside and inside pages — print it double-sided,
              flipped on the long edge, so each card&apos;s choices land on its own reverse.
            </p>
          )}
        </div>
      </Modal>

      <PlaceCardTemplateEditor
        isOpen={editorOpen}
        onClose={() => setEditorOpen(false)}
        eventUuid={plan.event_id}
        template={template}
        scopeLabel={scopeLabel}
        onSaved={setTemplate}
      />
    </>
  );
}

export default PlaceCardModal;
