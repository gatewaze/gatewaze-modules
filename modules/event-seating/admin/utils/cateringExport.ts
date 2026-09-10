import { supabase } from '@/lib/supabase';
import type { SeatingPlan, SeatingTable, SeatingAssignment, Guest } from './seatingService';
// Value import, but cateringPdf has no data-layer imports of its own, so this
// stays free of the supabase client.
import { NO_CHOICE } from './cateringPdf';

/**
 * The venue's running order: for each course, who is sitting where and what
 * they chose. One sheet per course, guests grouped under their table, plus a
 * kitchen total per option.
 *
 * Choices come from the event-invites RSVP answers — `invite_responses` joined
 * to `invite_questions` — so a "course" here is just a question on the invite
 * (Main Meal, Dessert) that the caller picks.
 */

export interface CourseQuestion {
  id: string;
  /** Flattened question text — `question_text` holds rich-text HTML. */
  label: string;
  sort_order: number;
}

export interface CourseRow {
  tableLabel: string;
  tableSort: number;
  seatIndex: number;
  guestName: string;
  choice: string;
}

export interface CourseSheet {
  label: string;
  rows: CourseRow[];
  /** Option → head count, highest first. */
  totals: Array<[string, number]>;
  /** Seated guests with no answer recorded for this course. */
  missing: number;
}

function answerToString(answer: unknown): string {
  if (answer == null) return '';
  if (typeof answer === 'string') return answer;
  if (Array.isArray(answer)) return (answer as unknown[]).map((a) => String(a)).join(', ');
  if (typeof answer === 'boolean') return answer ? 'Yes' : 'No';
  return JSON.stringify(answer);
}

/**
 * Remove markup without a regex. Tracking `<`/`>` depth means nested or
 * malformed forms like "<scr<script>ipt>" cannot leave a live tag behind,
 * which a `/<[^>]*>/g` strip does — that is a known-bad tag filter, and one
 * CodeQL rightly rejects.
 */
function stripTags(input: string): string {
  let out = '';
  let depth = 0;
  for (const ch of input) {
    if (ch === '<') depth++;
    else if (ch === '>') { if (depth > 0) depth--; }
    else if (depth === 0) out += ch;
  }
  return out;
}

/** Strip the rich-text wrapper a question is authored with. */
function plainText(html: string | null | undefined): string {
  if (!html) return '';
  const spaced = html.replace(/<\/(?:p|div|li|ul|ol|h[1-6]|blockquote|tr)>|<br\s*\/?>/gi, ' ');
  if (typeof DOMParser === 'undefined') {
    return stripTags(spaced).replace(/\s+/g, ' ').trim();
  }
  const doc = new DOMParser().parseFromString(spaced, 'text/html');
  doc.body.querySelectorAll('script, style, noscript, template').forEach((el) => el.remove());
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * Questions available as courses for this plan. Sub-event questions come
 * first when the plan is tied to one, since those are the ones that were
 * actually asked of these guests.
 */
export async function getCourseQuestions(
  eventUuid: string,
  subEventId: string | null,
): Promise<CourseQuestion[]> {
  const { data, error } = await supabase
    .from('invite_questions')
    .select('id, question_text, sub_event_id, sort_order')
    .eq('event_id', eventUuid)
    .order('sort_order');
  if (error) throw error;

  return (data || [])
    .filter((q) => !subEventId || q.sub_event_id === subEventId || q.sub_event_id === null)
    .map((q) => ({
      id: q.id,
      label: plainText(q.question_text) || 'Untitled question',
      sort_order: q.sort_order ?? 0,
    }));
}

/** Questions that look like meal courses, used to preselect sensible defaults. */
export function guessCourseQuestions(questions: CourseQuestion[]): string[] {
  const wanted = /(main|dessert|starter|course|meal|pudding)/i;
  // "Any dietary restrictions" is a note for the kitchen, not a course choice.
  const excluded = /(dietar|allerg|special request|access|song|drink)/i;
  return questions
    .filter((q) => wanted.test(q.label) && !excluded.test(q.label))
    .map((q) => q.id);
}

/**
 * Build one sheet per selected course. Only seated guests appear — the point
 * of the document is to tell the venue what to put down at each seat.
 */
export async function buildCourseSheets(input: {
  plan: SeatingPlan;
  tables: SeatingTable[];
  assignments: SeatingAssignment[];
  guests: Guest[];
  questions: CourseQuestion[];
  selectedQuestionIds: string[];
}): Promise<CourseSheet[]> {
  const { plan, tables, assignments, guests, questions, selectedQuestionIds } = input;
  if (selectedQuestionIds.length === 0) return [];

  const guestsById = new Map(guests.map((g) => [g.id, g]));
  const tablesById = new Map(tables.map((t) => [t.id, t]));

  const seated = assignments.filter((a) => a.party_member_id || a.guest_label);
  const memberIds = seated
    .map((a) => a.party_member_id)
    .filter((id): id is string => !!id);

  // member → the member_event carrying this plan's RSVP, which is what the
  // answers hang off.
  const memberEventIdByMember = new Map<string, string>();
  if (memberIds.length > 0) {
    const BATCH = 100;
    for (let i = 0; i < memberIds.length; i += BATCH) {
      const slice = memberIds.slice(i, i + BATCH);
      let query = supabase
        .from('invite_party_member_events')
        .select('id, party_member_id, sub_event_id')
        .eq('event_id', plan.event_id)
        .in('party_member_id', slice);
      query = plan.sub_event_id
        ? query.eq('sub_event_id', plan.sub_event_id)
        : query.is('sub_event_id', null);
      const { data, error } = await query;
      if (error) throw error;
      for (const row of data || []) {
        if (row.party_member_id) memberEventIdByMember.set(row.party_member_id, row.id);
      }
    }
  }

  // answers, keyed member_event + question
  const answerByKey = new Map<string, string>();
  const memberEventIds = [...memberEventIdByMember.values()];
  if (memberEventIds.length > 0) {
    const BATCH = 100;
    for (let i = 0; i < memberEventIds.length; i += BATCH) {
      const slice = memberEventIds.slice(i, i + BATCH);
      const { data, error } = await supabase
        .from('invite_responses')
        .select('party_member_event_id, question_id, answer')
        .in('party_member_event_id', slice)
        .in('question_id', selectedQuestionIds);
      if (error) throw error;
      for (const row of data || []) {
        answerByKey.set(`${row.party_member_event_id}:${row.question_id}`, answerToString(row.answer));
      }
    }
  }

  const questionById = new Map(questions.map((q) => [q.id, q]));

  return selectedQuestionIds
    .map((questionId) => {
      const question = questionById.get(questionId);
      if (!question) return null;

      const rows: CourseRow[] = [];
      let missing = 0;

      for (const assignment of seated) {
        const table = tablesById.get(assignment.table_id);
        if (!table) continue;

        const guest = assignment.party_member_id ? guestsById.get(assignment.party_member_id) : undefined;
        const guestName = guest?.full_name || assignment.guest_label || 'Guest';

        const memberEventId = assignment.party_member_id
          ? memberEventIdByMember.get(assignment.party_member_id)
          : undefined;
        const raw = memberEventId ? answerByKey.get(`${memberEventId}:${questionId}`) : undefined;
        const choice = (raw || '').trim();
        if (!choice) missing++;

        rows.push({
          tableLabel: table.label,
          tableSort: table.sort_order,
          seatIndex: assignment.seat_index,
          guestName,
          choice: choice || NO_CHOICE,
        });
      }

      rows.sort(
        (a, b) =>
          a.tableSort - b.tableSort ||
          a.tableLabel.localeCompare(b.tableLabel) ||
          a.seatIndex - b.seatIndex,
      );

      const counts = new Map<string, number>();
      for (const row of rows) counts.set(row.choice, (counts.get(row.choice) || 0) + 1);
      const totals = [...counts.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      );

      return { label: question.label, rows, totals, missing };
    })
    .filter((sheet): sheet is CourseSheet => sheet !== null);
}
