import { supabase } from '@/lib/supabase';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RsvpStatus = 'pending' | 'accepted' | 'declined' | 'maybe';
export const RSVP_STATUSES: RsvpStatus[] = ['pending', 'accepted', 'declined', 'maybe'];

export type TableShape = 'round' | 'rect';
export type SeatLayout = 'around' | 'both_sides' | 'one_side';

export const TABLE_SHAPES: TableShape[] = ['round', 'rect'];
export const SEAT_LAYOUTS: SeatLayout[] = ['around', 'both_sides', 'one_side'];

export interface SeatingPlan {
  id: string;
  event_id: string;
  sub_event_id: string | null;
  name: string;
  canvas_width: number;
  canvas_height: number;
  grid_size: number;
  snap_to_grid: boolean;
  background_asset_id: string | null;
  background_hidden: boolean;
  guest_statuses: RsvpStatus[];
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface SeatingTable {
  id: string;
  plan_id: string;
  label: string;
  shape: TableShape;
  seat_layout: SeatLayout;
  seat_count: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  colour: string | null;
  notes: string | null;
  sort_order: number;
}

export interface SeatingAssignment {
  id: string;
  plan_id: string;
  table_id: string;
  seat_index: number;
  party_member_id: string | null;
  guest_label: string | null;
  notes: string | null;
}

export interface SeatingAsset {
  id: string;
  event_id: string;
  filename: string;
  storage_path: string;
  storage_bucket: string;
  mime_type: string | null;
  file_size: number | null;
}

export interface Guest {
  /** invite_party_members.id */
  id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string;
  is_plus_one: boolean;
  party_id: string;
  party_name: string;
  rsvp_status: RsvpStatus;
}

export interface SubEvent {
  id: string;
  name: string;
  starts_at: string | null;
  sort_order: number;
}

// ---------------------------------------------------------------------------
// Validation helpers
//
// Values reaching PostgREST filters or CHECK-constrained columns are validated
// here rather than trusting whatever a caller passes through.
// ---------------------------------------------------------------------------

function assertUuid(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function toStatusList(values: unknown): RsvpStatus[] {
  const list = Array.isArray(values) ? values : [];
  const allowed = list.filter((v): v is RsvpStatus =>
    typeof v === 'string' && (RSVP_STATUSES as string[]).includes(v));
  return allowed.length > 0 ? allowed : ['accepted'];
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

// Only these columns may be written from the editor. Anything else in a
// caller-supplied patch is dropped rather than forwarded to the database.
const TABLE_WRITABLE = [
  'label', 'shape', 'seat_layout', 'seat_count',
  'x', 'y', 'width', 'height', 'rotation', 'colour', 'notes', 'sort_order',
] as const;

const PLAN_WRITABLE = [
  'name', 'canvas_width', 'canvas_height', 'grid_size', 'snap_to_grid',
  'background_asset_id', 'background_hidden', 'guest_statuses', 'notes',
] as const;

function pickWritable<T extends string>(
  patch: Record<string, unknown>,
  allowed: readonly T[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in patch) out[key] = patch[key];
  }
  return out;
}

function sanitiseTablePatch(patch: Partial<SeatingTable>): Record<string, unknown> {
  const clean = pickWritable(patch as Record<string, unknown>, TABLE_WRITABLE);
  if ('shape' in clean && !TABLE_SHAPES.includes(clean.shape as TableShape)) {
    throw new Error('Invalid table shape');
  }
  if ('seat_layout' in clean && !SEAT_LAYOUTS.includes(clean.seat_layout as SeatLayout)) {
    throw new Error('Invalid seat layout');
  }
  if ('seat_count' in clean) clean.seat_count = Math.round(clamp(Number(clean.seat_count), 0, 40));
  if ('width' in clean) clean.width = clamp(Number(clean.width), 20, 5000);
  if ('height' in clean) clean.height = clamp(Number(clean.height), 20, 5000);
  if ('rotation' in clean) clean.rotation = clamp(Number(clean.rotation), -360, 360);
  if ('x' in clean) clean.x = clamp(Number(clean.x), -20000, 20000);
  if ('y' in clean) clean.y = clamp(Number(clean.y), -20000, 20000);
  if ('label' in clean) clean.label = String(clean.label ?? '').slice(0, 120) || 'Table';
  return clean;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export async function getPlans(eventUuid: string): Promise<SeatingPlan[]> {
  const { data, error } = await supabase
    .from('seating_plans')
    .select('*')
    .eq('event_id', assertUuid(eventUuid, 'event id'))
    .order('created_at');
  if (error) throw error;
  return (data || []).map((p) => ({ ...p, guest_statuses: toStatusList(p.guest_statuses) }));
}

export async function createPlan(input: {
  event_id: string;
  sub_event_id: string | null;
  name: string;
  guest_statuses?: RsvpStatus[];
}): Promise<SeatingPlan> {
  const { data, error } = await supabase
    .from('seating_plans')
    .insert({
      event_id: assertUuid(input.event_id, 'event id'),
      sub_event_id: input.sub_event_id ? assertUuid(input.sub_event_id, 'sub-event id') : null,
      name: input.name.trim().slice(0, 120) || 'Seating plan',
      guest_statuses: toStatusList(input.guest_statuses ?? ['accepted']),
    })
    .select()
    .single();
  if (error) throw error;
  return { ...data, guest_statuses: toStatusList(data.guest_statuses) };
}

export async function updatePlan(id: string, patch: Partial<SeatingPlan>): Promise<void> {
  const planId = assertUuid(id, 'plan id');
  const clean = pickWritable(patch as Record<string, unknown>, PLAN_WRITABLE);
  if ('guest_statuses' in clean) clean.guest_statuses = toStatusList(clean.guest_statuses);
  if (clean.background_asset_id) {
    // The FK only proves the asset exists. Confirm it belongs to this plan's
    // own event so a plan can never point at another event's floor plan.
    await assertAssetBelongsToPlan(planId, String(clean.background_asset_id));
  }
  if ('canvas_width' in clean) clean.canvas_width = Math.round(clamp(Number(clean.canvas_width), 200, 20000));
  if ('canvas_height' in clean) clean.canvas_height = Math.round(clamp(Number(clean.canvas_height), 200, 20000));
  if ('grid_size' in clean) clean.grid_size = Math.round(clamp(Number(clean.grid_size), 0, 500));
  if (Object.keys(clean).length === 0) return;

  const { error } = await supabase
    .from('seating_plans')
    .update(clean)
    .eq('id', planId);
  if (error) throw error;
}

async function assertAssetBelongsToPlan(planId: string, assetId: string): Promise<void> {
  const { data: plan, error: planError } = await supabase
    .from('seating_plans')
    .select('event_id')
    .eq('id', planId)
    .maybeSingle();
  if (planError) throw planError;
  if (!plan) throw new Error('Plan not found');

  const { data: asset, error: assetError } = await supabase
    .from('seating_assets')
    .select('event_id')
    .eq('id', assertUuid(assetId, 'floor plan id'))
    .maybeSingle();
  if (assetError) throw assetError;
  if (!asset || asset.event_id !== plan.event_id) {
    throw new Error('That floor plan belongs to a different event');
  }
}

export async function deletePlan(id: string): Promise<void> {
  const { error } = await supabase
    .from('seating_plans')
    .delete()
    .eq('id', assertUuid(id, 'plan id'));
  if (error) throw error;
}

/** Copy a plan's tables (and optionally its seated guests) into a new plan. */
export async function duplicatePlan(
  plan: SeatingPlan,
  opts: { name: string; sub_event_id: string | null; copyGuests: boolean },
): Promise<SeatingPlan> {
  const copy = await createPlan({
    event_id: plan.event_id,
    sub_event_id: opts.sub_event_id,
    name: opts.name,
    guest_statuses: plan.guest_statuses,
  });
  await updatePlan(copy.id, {
    canvas_width: plan.canvas_width,
    canvas_height: plan.canvas_height,
    grid_size: plan.grid_size,
    snap_to_grid: plan.snap_to_grid,
    background_asset_id: plan.background_asset_id,
    background_hidden: plan.background_hidden,
  });

  const tables = await getTables(plan.id);
  if (tables.length === 0) return copy;

  const { data: inserted, error } = await supabase
    .from('seating_tables')
    .insert(tables.map((t) => ({ ...sanitiseTablePatch(t), plan_id: copy.id })))
    .select();
  if (error) throw error;

  if (opts.copyGuests && inserted) {
    // Match old table → new table by insertion order, which mirrors the
    // order the originals were read in.
    const idMap = new Map<string, string>();
    tables.forEach((t, i) => { if (inserted[i]) idMap.set(t.id, inserted[i].id); });
    const assignments = await getAssignments(plan.id);
    const rows = assignments
      .map((a) => {
        const newTableId = idMap.get(a.table_id);
        if (!newTableId) return null;
        return {
          plan_id: copy.id,
          table_id: newTableId,
          seat_index: a.seat_index,
          party_member_id: a.party_member_id,
          guest_label: a.guest_label,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length > 0) {
      const { error: assignError } = await supabase.from('seating_assignments').insert(rows);
      if (assignError) throw assignError;
    }
  }

  return copy;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export async function getTables(planId: string): Promise<SeatingTable[]> {
  const { data, error } = await supabase
    .from('seating_tables')
    .select('*')
    .eq('plan_id', assertUuid(planId, 'plan id'))
    .order('sort_order')
    .order('created_at');
  if (error) throw error;
  return (data || []) as SeatingTable[];
}

export async function createTable(
  planId: string,
  input: Partial<SeatingTable>,
): Promise<SeatingTable> {
  const { data, error } = await supabase
    .from('seating_tables')
    .insert({ ...sanitiseTablePatch(input), plan_id: assertUuid(planId, 'plan id') })
    .select()
    .single();
  if (error) throw error;
  return data as SeatingTable;
}

export async function updateTable(id: string, patch: Partial<SeatingTable>): Promise<void> {
  const clean = sanitiseTablePatch(patch);
  if (Object.keys(clean).length === 0) return;
  const { error } = await supabase
    .from('seating_tables')
    .update(clean)
    .eq('id', assertUuid(id, 'table id'));
  if (error) throw error;
}

export async function deleteTable(id: string): Promise<void> {
  const { error } = await supabase
    .from('seating_tables')
    .delete()
    .eq('id', assertUuid(id, 'table id'));
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export async function getAssignments(planId: string): Promise<SeatingAssignment[]> {
  const { data, error } = await supabase
    .from('seating_assignments')
    .select('*')
    .eq('plan_id', assertUuid(planId, 'plan id'));
  if (error) throw error;
  return (data || []) as SeatingAssignment[];
}

/**
 * Seat an occupant in a specific seat.
 *
 * Dropping onto an occupied seat swaps the two guests when the incoming one
 * came from another seat, and bumps the sitting guest back to the tray when
 * the incoming one came from the tray. PostgREST gives us no transaction, so
 * the vacating delete happens before the placing write (the unique
 * (table_id, seat_index) index would otherwise reject it) and the caller
 * reloads assignments afterwards to resettle on real server state.
 */
export async function seatOccupant(input: {
  planId: string;
  tableId: string;
  seatIndex: number;
  /** Existing assignment being moved, if the guest was already seated. */
  movingAssignmentId?: string | null;
  partyMemberId?: string | null;
  guestLabel?: string | null;
}): Promise<void> {
  const planId = assertUuid(input.planId, 'plan id');
  const tableId = assertUuid(input.tableId, 'table id');
  const seatIndex = Math.round(clamp(input.seatIndex, 0, 39));

  const { data: occupantRows, error: occupantError } = await supabase
    .from('seating_assignments')
    .select('*')
    .eq('table_id', tableId)
    .eq('seat_index', seatIndex)
    .limit(1);
  if (occupantError) throw occupantError;
  const occupant = (occupantRows || [])[0] as SeatingAssignment | undefined;

  if (occupant && occupant.id === input.movingAssignmentId) return; // dropped back where it started

  let source: SeatingAssignment | null = null;
  if (input.movingAssignmentId) {
    const { data, error } = await supabase
      .from('seating_assignments')
      .select('*')
      .eq('id', assertUuid(input.movingAssignmentId, 'assignment id'))
      .maybeSingle();
    if (error) throw error;
    source = (data as SeatingAssignment) || null;
  }

  // Free the target seat first.
  if (occupant) {
    const { error } = await supabase
      .from('seating_assignments')
      .delete()
      .eq('id', occupant.id);
    if (error) throw error;
  }

  // Place the incoming guest.
  if (source) {
    const { error } = await supabase
      .from('seating_assignments')
      .update({ table_id: tableId, seat_index: seatIndex })
      .eq('id', source.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('seating_assignments').insert({
      plan_id: planId,
      table_id: tableId,
      seat_index: seatIndex,
      party_member_id: input.partyMemberId
        ? assertUuid(input.partyMemberId, 'guest id')
        : null,
      guest_label: input.partyMemberId ? null : (input.guestLabel || '').trim().slice(0, 120) || null,
    });
    if (error) throw error;
  }

  // Complete the swap: the displaced guest takes the seat just vacated.
  if (occupant && source) {
    const { error } = await supabase.from('seating_assignments').insert({
      plan_id: planId,
      table_id: source.table_id,
      seat_index: source.seat_index,
      party_member_id: occupant.party_member_id,
      guest_label: occupant.guest_label,
      notes: occupant.notes,
    });
    if (error) throw error;
  }
}

export async function unseat(assignmentId: string): Promise<void> {
  const { error } = await supabase
    .from('seating_assignments')
    .delete()
    .eq('id', assertUuid(assignmentId, 'assignment id'));
  if (error) throw error;
}

export async function clearTableSeats(tableId: string): Promise<void> {
  const { error } = await supabase
    .from('seating_assignments')
    .delete()
    .eq('table_id', assertUuid(tableId, 'table id'));
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Guests — sourced from event-invites RSVPs
// ---------------------------------------------------------------------------

export async function getSubEvents(eventUuid: string): Promise<SubEvent[]> {
  const { data, error } = await supabase
    .from('invite_sub_events')
    .select('id, name, starts_at, sort_order')
    .eq('event_id', assertUuid(eventUuid, 'event id'))
    .order('sort_order');
  if (error) throw error;
  return (data || []) as SubEvent[];
}

/**
 * Everyone eligible to be seated: party members whose RSVP for this
 * event/sub-event is in `statuses`. Fetched as three plain queries rather than
 * a nested embed so it does not depend on FK constraint naming.
 */
export async function getGuests(
  eventUuid: string,
  subEventId: string | null,
  statuses: RsvpStatus[],
): Promise<Guest[]> {
  const wanted = toStatusList(statuses);

  let query = supabase
    .from('invite_party_member_events')
    .select('party_member_id, rsvp_status')
    .eq('event_id', assertUuid(eventUuid, 'event id'))
    .in('rsvp_status', wanted);
  query = subEventId
    ? query.eq('sub_event_id', assertUuid(subEventId, 'sub-event id'))
    : query.is('sub_event_id', null);

  const { data: memberEvents, error } = await query;
  if (error) throw error;

  const statusByMember = new Map<string, RsvpStatus>();
  for (const row of memberEvents || []) {
    if (row.party_member_id) statusByMember.set(row.party_member_id, row.rsvp_status as RsvpStatus);
  }
  const memberIds = [...statusByMember.keys()];
  if (memberIds.length === 0) return [];

  const { data: members, error: membersError } = await supabase
    .from('invite_party_members')
    .select('id, first_name, last_name, is_plus_one, party_id, sort_order')
    .in('id', memberIds);
  if (membersError) throw membersError;

  const partyIds = [...new Set((members || []).map((m) => m.party_id).filter(Boolean))];
  const partyNames = new Map<string, string>();
  if (partyIds.length > 0) {
    const { data: parties, error: partiesError } = await supabase
      .from('invite_parties')
      .select('id, name')
      .in('id', partyIds);
    if (partiesError) throw partiesError;
    for (const party of parties || []) partyNames.set(party.id, party.name);
  }

  return (members || [])
    .map((m) => {
      const fullName = [m.first_name, m.last_name].filter(Boolean).join(' ').trim();
      return {
        id: m.id,
        first_name: m.first_name,
        last_name: m.last_name,
        full_name: fullName || 'Unnamed guest',
        is_plus_one: !!m.is_plus_one,
        party_id: m.party_id,
        party_name: partyNames.get(m.party_id) || 'Unknown party',
        rsvp_status: statusByMember.get(m.id) || 'pending',
      };
    })
    .sort((a, b) =>
      a.party_name.localeCompare(b.party_name) || a.full_name.localeCompare(b.full_name));
}

// ---------------------------------------------------------------------------
// Floor plan backgrounds
// ---------------------------------------------------------------------------

const ALLOWED_BACKGROUND_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const MAX_BACKGROUND_BYTES = 15 * 1024 * 1024;

export async function getAssets(eventUuid: string): Promise<SeatingAsset[]> {
  const { data, error } = await supabase
    .from('seating_assets')
    .select('*')
    .eq('event_id', assertUuid(eventUuid, 'event id'))
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []) as SeatingAsset[];
}

export async function uploadBackground(eventUuid: string, file: File): Promise<SeatingAsset> {
  if (!ALLOWED_BACKGROUND_TYPES.includes(file.type)) {
    throw new Error('Floor plans must be a PNG, JPEG, WebP or PDF file');
  }
  if (file.size > MAX_BACKGROUND_BYTES) {
    throw new Error('Floor plan must be smaller than 15MB');
  }
  const eventId = assertUuid(eventUuid, 'event id');
  const assetId = crypto.randomUUID();
  // Path is built from generated ids only — the uploaded filename is stored as
  // a column, never used to construct the storage path.
  const extension = file.type === 'application/pdf' ? 'pdf' : file.type.split('/')[1];
  const storagePath = `${eventId}/backgrounds/${assetId}.${extension}`;

  const { error: uploadError } = await supabase.storage
    .from('event-seating')
    .upload(storagePath, file, { upsert: false, contentType: file.type });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase
    .from('seating_assets')
    .insert({
      id: assetId,
      event_id: eventId,
      filename: file.name.slice(0, 200),
      storage_path: storagePath,
      mime_type: file.type,
      file_size: file.size,
    })
    .select()
    .single();
  if (error) throw error;
  return data as SeatingAsset;
}

export function getAssetPublicUrl(asset: SeatingAsset): string {
  const { data } = supabase.storage.from(asset.storage_bucket).getPublicUrl(asset.storage_path);
  return data.publicUrl;
}
