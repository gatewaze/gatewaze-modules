import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, Modal } from '@/components/ui';
import {
  buildCourseSheets,
  getCourseQuestions,
  guessCourseQuestions,
  type CourseQuestion,
} from '../utils/cateringExport';
import { downloadCateringPdf } from '../utils/cateringPdf';
import type { Guest, SeatingAssignment, SeatingPlan, SeatingTable } from '../utils/seatingService';

/**
 * Picks which RSVP questions become course sheets, then produces the venue's
 * PDF: one sheet per course, guests listed under their table in seat order,
 * with a kitchen total per option.
 */

interface Props {
  isOpen: boolean;
  onClose: () => void;
  plan: SeatingPlan;
  tables: SeatingTable[];
  assignments: SeatingAssignment[];
  guests: Guest[];
  documentTitle: string;
  subtitle: string;
}

export function CateringPdfModal({
  isOpen,
  onClose,
  plan,
  tables,
  assignments,
  guests,
  documentTitle,
  subtitle,
}: Props) {
  const [questions, setQuestions] = useState<CourseQuestion[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const rows = await getCourseQuestions(plan.event_id, plan.sub_event_id);
        if (cancelled) return;
        setQuestions(rows);
        // Preselect the ones that look like courses, in the order they were
        // asked, so the common case is one click.
        setSelected((current) => (current.length > 0 ? current : guessCourseQuestions(rows)));
      } catch (err) {
        console.error('[event-seating] Failed to load questions:', err);
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

  const handleGenerate = async () => {
    if (selected.length === 0) {
      toast.error('Pick at least one course');
      return;
    }
    setGenerating(true);
    try {
      // Keep sheets in the order the questions were asked, not click order.
      const ordered = questions
        .filter((q) => selected.includes(q.id))
        .map((q) => q.id);

      const sheets = await buildCourseSheets({
        plan,
        tables,
        assignments,
        guests,
        questions,
        selectedQuestionIds: ordered,
      });

      if (sheets.every((s) => s.rows.length === 0)) {
        toast.error('Nobody is seated yet, so there is nothing to send the venue');
        return;
      }

      const stem = plan.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      await downloadCateringPdf({
        sheets,
        title: documentTitle,
        subtitle,
        filename: `${stem || 'seating'}-meal-selections.pdf`,
      });

      const withoutChoice = sheets.reduce((sum, s) => sum + s.missing, 0);
      if (withoutChoice > 0) {
        toast.warning(`Generated — ${withoutChoice} seat${withoutChoice === 1 ? '' : 's'} had no selection recorded`);
      } else {
        toast.success('Meal selection PDF generated');
      }
      onClose();
    } catch (err) {
      console.error('[event-seating] Failed to generate the catering PDF:', err);
      toast.error('Could not generate the PDF');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Meal selections for the venue"
      size="md"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--gray-9)]">
            {seatedCount} seated guest{seatedCount === 1 ? '' : 's'}
          </span>
          <div className="flex gap-2">
            <Button variant="soft" size="2" onClick={onClose}>Cancel</Button>
            <Button
              size="2"
              disabled={generating || loading || selected.length === 0}
              onClick={handleGenerate}
            >
              {generating ? 'Generating…' : 'Generate PDF'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3 p-1">
        <p className="text-sm text-[var(--gray-11)]">
          Each course you pick becomes its own sheet, listing every seated guest under their
          table in seat order, with a total per option for the kitchen.
        </p>

        {loading ? (
          <p className="py-4 text-center text-sm text-[var(--gray-9)]">Loading questions…</p>
        ) : questions.length === 0 ? (
          <p className="py-4 text-center text-sm text-[var(--gray-9)]">
            This event has no RSVP questions, so there are no meal selections to report.
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
      </div>
    </Modal>
  );
}

export default CateringPdfModal;
