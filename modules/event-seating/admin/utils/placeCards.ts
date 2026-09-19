import { supabase } from '@/lib/supabase';
import { assertUuid, type Guest, type SeatingAssignment, type SeatingPlan, type SeatingTable } from './seatingService';
import { planSeatNumbers, seatKey } from './seatNumbering';
import { answerToString, type CourseQuestion } from './cateringExport';

/**
 * Folded table place-name cards.
 *
 * The physical card is an A-card: 83mm wide, 54mm tall per face, supplied
 * flat with a scored fold across the middle. It prints flat in portrait at
 * 83 x 108mm — the bottom half is the front of the standing tent, the top
 * half is the back (so anything on it prints rotated 180 degrees), and the
 * reverse side of the sheet is the inside of the card.
 *
 * Templates live in the event-invites template system (`invite_templates`,
 * channel 'place_card'), so they share the event's uploaded fonts and the
 * same sub-event-then-default matching as invite PDFs. Fields reuse the
 * invites `pdf_fields` shape plus a `face` marker saying which side of the
 * card ('outside' or 'inside') the field belongs to.
 */

const MM_TO_PT = 72 / 25.4;

/** Flat-card page size in PDF points: 83mm wide, 2 x 54mm tall. */
export const CARD_WIDTH_PT = Math.round(83 * MM_TO_PT * 100) / 100;   // 235.28
export const CARD_HEIGHT_PT = Math.round(108 * MM_TO_PT * 100) / 100; // 306.14
/** The scored fold, halfway up the flat card. */
export const CARD_FOLD_PT = Math.round(54 * MM_TO_PT * 100) / 100;    // 153.07

export type CardFace = 'outside' | 'inside';

export interface PlaceCardField {
  face: CardFace;
  /** Variable path (e.g. 'guest.first_name') — ignored when `text` is set. */
  variable?: string;
  /** Literal static text — when set, overrides `variable`. */
  text?: string;
  /** Baseline anchor in PDF points, origin bottom-left of the flat card. */
  x: number;
  y: number;
  /** Degrees, counter-clockwise (matches pdf-lib). 180 = upside-down. */
  rotation?: number;
  fontSize?: number;
  /** Multiplier applied to fontSize (default 1.0). */
  lineHeight?: number;
  /** invite_template_assets id of an uploaded font; Helvetica when unset. */
  fontAssetId?: string;
  color?: string;
  align?: 'left' | 'center' | 'right';
  /** Wrap width in points; no wrapping when unset. */
  maxWidth?: number;
}

export interface PlaceCardTemplate {
  id: string;
  event_id: string;
  sub_event_id: string | null;
  channel: 'place_card';
  name: string;
  pdf_fields: PlaceCardField[];
  is_active: boolean;
  updated_at: string;
}

/** Fonts uploaded through the invites template editor — shared per event. */
export interface FontAsset {
  id: string;
  filename: string;
  storage_path: string;
  storage_bucket: string;
}

// ---------------------------------------------------------------------------
// Default layout
// ---------------------------------------------------------------------------

/**
 * The starting layout: first name large over last name smaller, upright on
 * the front face and repeated rotated 180 on the back face so the name reads
 * from both sides of the standing tent. Meal choices go on the inside, on
 * the half that reads upright when you look into the standing card from the
 * front. Mirrored positions reflect the glyph box through the fold
 * (y' = 2 * fold - y), which is why the rotated pair reuses the upright y.
 */
export function defaultPlaceCardFields(): PlaceCardField[] {
  const cx = CARD_WIDTH_PT / 2;
  const firstY = 92;
  const lastY = 60;
  return [
    // Front of the tent (bottom half, upright)
    { face: 'outside', variable: 'guest.first_name', x: cx, y: firstY, fontSize: 30, align: 'center', color: '#000000', maxWidth: 220 },
    { face: 'outside', variable: 'guest.last_name', x: cx, y: lastY, fontSize: 16, align: 'center', color: '#000000', maxWidth: 220 },
    // Back of the tent (top half, printed upside-down so it stands upright)
    { face: 'outside', variable: 'guest.first_name', x: cx, y: 2 * CARD_FOLD_PT - firstY, rotation: 180, fontSize: 30, align: 'center', color: '#000000', maxWidth: 220 },
    { face: 'outside', variable: 'guest.last_name', x: cx, y: 2 * CARD_FOLD_PT - lastY, rotation: 180, fontSize: 16, align: 'center', color: '#000000', maxWidth: 220 },
    // Inside: meal choices on the top half, rotated so they read upright
    // when the standing card is viewed from the front.
    { face: 'inside', variable: 'meal.choices', x: cx, y: CARD_FOLD_PT + 26, rotation: 180, fontSize: 11, lineHeight: 1.5, align: 'center', color: '#000000', maxWidth: 210 },
  ];
}

// ---------------------------------------------------------------------------
// Template storage (invite_templates, channel 'place_card')
// ---------------------------------------------------------------------------

function normalizeFields(raw: unknown): PlaceCardField[] {
  if (!Array.isArray(raw)) return [];
  return (raw as PlaceCardField[]).map((f) => ({
    ...f,
    face: f.face === 'inside' ? 'inside' : 'outside',
  }));
}

/**
 * The template the generator will use for a plan: a sub-event-specific one
 * when the plan is tied to a sub-event, otherwise the event default — the
 * same matching the invites channels use.
 */
export async function findPlaceCardTemplate(
  eventId: string,
  subEventId: string | null,
): Promise<PlaceCardTemplate | null> {
  assertUuid(eventId, 'event id');
  if (subEventId) {
    assertUuid(subEventId, 'sub-event id');
    const { data } = await supabase
      .from('invite_templates')
      .select('id, event_id, sub_event_id, channel, name, pdf_fields, is_active, updated_at')
      .eq('event_id', eventId)
      .eq('sub_event_id', subEventId)
      .eq('channel', 'place_card')
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (data && data.length > 0) {
      return { ...data[0], pdf_fields: normalizeFields(data[0].pdf_fields) } as PlaceCardTemplate;
    }
  }

  const { data } = await supabase
    .from('invite_templates')
    .select('id, event_id, sub_event_id, channel, name, pdf_fields, is_active, updated_at')
    .eq('event_id', eventId)
    .is('sub_event_id', null)
    .eq('channel', 'place_card')
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(1);
  if (data && data.length > 0) {
    return { ...data[0], pdf_fields: normalizeFields(data[0].pdf_fields) } as PlaceCardTemplate;
  }
  return null;
}

export async function savePlaceCardTemplate(input: {
  id?: string;
  event_id: string;
  sub_event_id: string | null;
  name: string;
  pdf_fields: PlaceCardField[];
}): Promise<PlaceCardTemplate> {
  const row = {
    event_id: assertUuid(input.event_id, 'event id'),
    sub_event_id: input.sub_event_id ? assertUuid(input.sub_event_id, 'sub-event id') : null,
    channel: 'place_card' as const,
    name: input.name,
    pdf_fields: input.pdf_fields,
    is_active: true,
  };
  const query = input.id
    ? supabase.from('invite_templates').update(row).eq('id', assertUuid(input.id, 'template id'))
    : supabase.from('invite_templates').insert(row);
  const { data, error } = await query
    .select('id, event_id, sub_event_id, channel, name, pdf_fields, is_active, updated_at')
    .single();
  if (error) throw error;
  return { ...data, pdf_fields: normalizeFields(data.pdf_fields) } as PlaceCardTemplate;
}

export async function getFontAssets(eventId: string): Promise<FontAsset[]> {
  const { data, error } = await supabase
    .from('invite_template_assets')
    .select('id, filename, storage_path, storage_bucket')
    .eq('event_id', assertUuid(eventId, 'event id'))
    .eq('asset_type', 'font')
    .order('created_at');
  if (error) throw error;
  return data || [];
}

export async function uploadFontAsset(eventId: string, file: File): Promise<FontAsset> {
  assertUuid(eventId, 'event id');
  const assetId = crypto.randomUUID();
  const ext = /\.otf$/i.test(file.name) ? 'otf' : 'ttf';
  const storagePath = `${eventId}/fonts/${assetId}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from('invite-templates')
    .upload(storagePath, file, { upsert: false });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase
    .from('invite_template_assets')
    .insert({
      id: assetId,
      event_id: eventId,
      asset_type: 'font',
      filename: file.name,
      storage_path: storagePath,
      mime_type: file.type,
      file_size: file.size,
      metadata: { font_family: file.name.replace(/\.(ttf|otf)$/i, '') },
    })
    .select('id, filename, storage_path, storage_bucket')
    .single();
  if (error) throw error;
  return data;
}

export function fontAssetPublicUrl(asset: FontAsset): string {
  const { data } = supabase.storage.from(asset.storage_bucket).getPublicUrl(asset.storage_path);
  return data.publicUrl;
}

// ---------------------------------------------------------------------------
// Per-guest context and variables
// ---------------------------------------------------------------------------

export interface PlaceCardContext {
  guest: { first_name: string; last_name: string; full_name: string };
  party: { name: string };
  table: { label: string };
  seat: { number: string };
  meal: { choices: string; choices_with_labels: string };
  event: { title: string };
  sub_event: { name: string };
}

export function resolvePlaceCardVariable(variable: string, context: PlaceCardContext): string {
  const [scope, field] = variable.split('.');
  if (!scope || !field) return '';
  const scopeObj = context[scope as keyof PlaceCardContext];
  if (!scopeObj) return '';
  return (scopeObj as Record<string, string>)[field] || '';
}

export function getPlaceCardVariables(): Array<{ variable: string; description: string; example: string }> {
  return [
    { variable: 'guest.first_name', description: 'Guest first name', example: 'Sarah' },
    { variable: 'guest.last_name', description: 'Guest last name', example: 'Swift' },
    { variable: 'guest.full_name', description: 'Guest full name', example: 'Sarah Swift' },
    { variable: 'meal.choices', description: 'Selected meal answers, one per line', example: 'Soup\nBeef Wellington' },
    { variable: 'meal.choices_with_labels', description: 'Course label before each answer', example: 'Starter: Soup' },
    { variable: 'table.label', description: 'Table name', example: 'Table 4' },
    { variable: 'seat.number', description: 'Seat number as shown on the plan', example: '23' },
    { variable: 'party.name', description: 'Invite party name', example: 'The Smiths' },
    { variable: 'event.title', description: 'Event title', example: 'Baker-Swift Wedding' },
    { variable: 'sub_event.name', description: 'Sub-event name', example: 'Day Ceremony' },
  ];
}

export const SAMPLE_PLACE_CARD_CONTEXT: PlaceCardContext = {
  guest: { first_name: 'Sarah', last_name: 'Swift', full_name: 'Sarah Swift' },
  party: { name: 'The Smiths' },
  table: { label: 'Table 4' },
  seat: { number: '23' },
  meal: {
    choices: 'Roasted Tomato Soup\nBeef Wellington\nChocolate Tart',
    choices_with_labels: 'Starter: Roasted Tomato Soup\nMain: Beef Wellington\nDessert: Chocolate Tart',
  },
  event: { title: 'Baker-Swift Wedding' },
  sub_event: { name: 'Day Ceremony' },
};

// ---------------------------------------------------------------------------
// Card data — one card per seated guest
// ---------------------------------------------------------------------------

export interface PlaceCard {
  context: PlaceCardContext;
  /** Sort keys so cards come out in the order the room is walked. */
  tableSort: number;
  tableLabel: string;
  seatNumber: number;
  /** True when no answer was recorded for any selected course. */
  missingMeal: boolean;
}

/**
 * One card per seated guest, in the order the venue lays the room: table
 * order then seat number (or straight seat number when the plan numbers
 * seats continuously). Custom guests seated as a plain label get a card
 * with the label as their name and no meal choices.
 */
export async function buildPlaceCards(input: {
  plan: SeatingPlan;
  tables: SeatingTable[];
  assignments: SeatingAssignment[];
  guests: Guest[];
  questions: CourseQuestion[];
  selectedQuestionIds: string[];
  eventTitle: string;
  subEventName: string;
}): Promise<PlaceCard[]> {
  const { plan, tables, assignments, guests, questions, selectedQuestionIds } = input;

  const guestsById = new Map(guests.map((g) => [g.id, g]));
  const tablesById = new Map(tables.map((t) => [t.id, t]));

  const seated = assignments.filter((a) => a.party_member_id || a.guest_label);
  const memberIds = seated
    .map((a) => a.party_member_id)
    .filter((id): id is string => !!id);

  // member → the member_event carrying this plan's RSVP, which the answers
  // hang off. Same join the catering sheets use.
  const memberEventIdByMember = new Map<string, string>();
  if (memberIds.length > 0 && selectedQuestionIds.length > 0) {
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

  const answerByKey = new Map<string, string>();
  const memberEventIds = [...memberEventIdByMember.values()];
  if (memberEventIds.length > 0 && selectedQuestionIds.length > 0) {
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

  // Keep courses in the order the questions were asked.
  const orderedQuestions = questions.filter((q) => selectedQuestionIds.includes(q.id));

  const seatNumberByTableSeat = planSeatNumbers(tables, plan.seat_numbering);

  const cards: PlaceCard[] = [];
  for (const assignment of seated) {
    const table = tablesById.get(assignment.table_id);
    if (!table) continue;

    // A guest stranded in a seat that has since been taken out of use gets
    // no card — there is no place setting to put it on.
    const seat = seatNumberByTableSeat.get(seatKey(table.id, assignment.seat_index));
    if (seat === undefined) continue;

    const guest = assignment.party_member_id ? guestsById.get(assignment.party_member_id) : undefined;
    const firstName = guest ? (guest.first_name || '') : (assignment.guest_label || 'Guest');
    const lastName = guest ? (guest.last_name || '') : '';
    const fullName = guest ? guest.full_name : (assignment.guest_label || 'Guest');

    const memberEventId = assignment.party_member_id
      ? memberEventIdByMember.get(assignment.party_member_id)
      : undefined;
    const choices: string[] = [];
    const labelled: string[] = [];
    for (const q of orderedQuestions) {
      const raw = memberEventId ? answerByKey.get(`${memberEventId}:${q.id}`) : undefined;
      const choice = (raw || '').trim();
      if (!choice) continue;
      choices.push(choice);
      labelled.push(`${q.label}: ${choice}`);
    }

    cards.push({
      context: {
        guest: { first_name: firstName, last_name: lastName, full_name: fullName },
        party: { name: guest?.party_name || '' },
        table: { label: table.label },
        seat: { number: String(seat) },
        meal: { choices: choices.join('\n'), choices_with_labels: labelled.join('\n') },
        event: { title: input.eventTitle },
        sub_event: { name: input.subEventName },
      },
      tableSort: table.sort_order,
      tableLabel: table.label,
      seatNumber: seat,
      missingMeal: selectedQuestionIds.length > 0 && choices.length === 0,
    });
  }

  cards.sort((a, b) =>
    plan.seat_numbering === 'continuous'
      ? a.seatNumber - b.seatNumber
      : a.tableSort - b.tableSort
        || a.tableLabel.localeCompare(b.tableLabel)
        || a.seatNumber - b.seatNumber);

  return cards;
}
