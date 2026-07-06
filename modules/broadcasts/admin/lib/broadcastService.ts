import { supabase } from '@/lib/supabase';
import type { SegmentDefinition } from '@/lib/segments';

// ---------------------------------------------------------------------------
// Types — uniform "parent content entity → many sends" model.
//   `broadcasts`        = the parent (definition + draft content + audience)
//   `broadcast_sends`   = send INSTANCES of a broadcast (status, schedule, counts)
// ---------------------------------------------------------------------------

export type BroadcastStatus =
  | 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelling' | 'cancelled' | 'failed' | 'paused';
export type AudienceType = 'segment' | 'list';
export type DeliveryStrategy = 'global' | 'tz_local' | 'personalised';

/** A send instance of a broadcast (a row in broadcast_sends). */
export interface BroadcastSendInstance {
  id: string;
  broadcast_id: string;
  status: BroadcastStatus;
  schedule_type: 'immediate' | 'scheduled';
  delivery_strategy: DeliveryStrategy;
  scheduled_at: string | null;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  created_at: string;
}

/** The broadcast parent — its definition, audience, and draft content. */
export interface Broadcast {
  id: string;
  name: string;
  brand: string;
  channel: 'email';
  audience_type: AudienceType;
  segment_id: string | null;
  list_ids: string[];
  category_list_id: string | null;
  /** Optional linked event (CFP / event promotion) — supplies {{event_*}} vars. */
  event_id: string | null;
  /** Optional mailbox to forward human replies to (like newsletter collections). */
  forward_replies_to: string | null;
  subject: string | null;
  preheader: string | null;
  from_address: string | null;
  from_name: string | null;
  reply_to: string | null;
  rendered_html: string | null;
  body_text: string | null;
  content_json: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Embedded send instances (when listed) — used to derive a summary status. */
  sends?: BroadcastSendInstance[];
}

export interface CreateBroadcastInput {
  name: string;
  brand?: string;
  audience_type?: AudienceType;
  segment_id?: string | null;
  list_ids?: string[];
  subject?: string;
}

export interface SendComposerConfig {
  scheduleType: 'immediate' | 'scheduled';
  scheduledAt: string | null;
  deliveryStrategy: DeliveryStrategy;
  targetLocal: string | null;
  defaultTimezone: string | null;
  excludeSentSendIds: string[];
}

export interface TimezoneBreakdownRow {
  timezone: string; recipients: number; sent: number; failed: number; pending: number; skipped: number; send_at: string;
}

export interface CopilotResult {
  success: boolean;
  definition?: SegmentDefinition;
  suggested_name?: string;
  explanation?: string;
  warnings?: string[];
  count?: number | null;
  sample?: Array<{ email: string; attributes?: Record<string, unknown> }>;
  error?: string;
}

/** Derive a single summary status/counts for a broadcast from its send instances. */
export function broadcastSummary(b: Broadcast): { status: BroadcastStatus; latest: BroadcastSendInstance | null } {
  const sends = (b.sends ?? []).slice().sort((a, c) => (a.created_at < c.created_at ? 1 : -1));
  const active = sends.find((s) => s.status === 'sending' || s.status === 'scheduled' || s.status === 'cancelling' || s.status === 'paused');
  const latest = active ?? sends[0] ?? null;
  return { status: latest?.status ?? 'draft', latest };
}

// ---------------------------------------------------------------------------
// Event link (CFP / event promotion)
//
// A broadcast can optionally link an event. Unlike the events Comms tab (whose
// audiences are RELATIONAL to the event — registrants/attendees/speakers), a
// linked broadcast still targets the broadcast's SEGMENT/lists; the event only
// supplies constant {{event_*}} merge variables (incl. the submit-talk URL) that
// are baked into the content at send-creation. We keep broadcasts' existing
// UNSCOPED merge-field convention ({{first_name}} etc., substituted per recipient
// at send time) and add distinct {{event_*}} tokens that don't collide with it.
// ---------------------------------------------------------------------------

/** Insertable event variables shown in the content editor when an event is linked. */
export const EVENT_VARIABLES: { token: string; label: string }[] = [
  { token: '{{event_name}}', label: 'Event name' },
  { token: '{{event_date}}', label: 'Event date' },
  { token: '{{event_city}}', label: 'Event city' },
  { token: '{{event_url}}', label: 'Event page URL' },
  { token: '{{event_cfp_url}}', label: 'Submit-a-talk (CFP) URL' },
];

export interface EventOption { id: string; event_title: string | null; event_start: string | null; }

export interface CategoryList { id: string; name: string; }

/** Lists a broadcast can be tied to for unsubscribe. EVERY broadcast must pick
 *  one — unsubscribing removes the recipient from this list. Shows ALL lists
 *  (including internal + inactive): we deliberately don't filter on is_internal
 *  — that both hid staff lists here and, on brands where the column isn't present
 *  yet (migration 003 unapplied), made the whole query error and return nothing. */
export async function listCategoryLists(): Promise<CategoryList[]> {
  const { data, error } = await supabase
    .from('lists')
    .select('id, name')
    .order('name');
  if (error) throw error;
  return (data ?? []) as CategoryList[];
}

/** Events available to link to a broadcast (most recent first). */
export async function listEventsForLink(): Promise<EventOption[]> {
  const { data, error } = await supabase
    .from('events')
    .select('id, event_title, event_start')
    .order('event_start', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as EventOption[];
}

/** Resolve the {{event_*}} token values for a linked event. portalBase is the
 *  public app origin (derived from the admin host in the browser). */
function eventVarValues(ev: { event_title: string | null; event_slug: string | null; event_id: string | null; event_start: string | null; event_city: string | null }, portalBase: string): Record<string, string> {
  const identifier = ev.event_slug || ev.event_id || '';
  const url = identifier ? `${portalBase}/events/${identifier}` : portalBase;
  const dateStr = ev.event_start
    ? new Date(ev.event_start).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : '';
  return {
    event_name: ev.event_title || '',
    event_date: dateStr,
    event_city: ev.event_city || '',
    event_url: url,
    event_cfp_url: identifier ? `${url}/talks` : url,
  };
}

/** Replace ONLY the {{event_*}} tokens, leaving per-recipient merge fields intact. */
function substituteEventVars(text: string, values: Record<string, string>): string {
  let out = text;
  for (const [key, val] of Object.entries(values)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), val);
  }
  return out;
}

function portalBaseFromAdmin(): string {
  if (typeof window === 'undefined') return '';
  const host = window.location.hostname.replace('-admin.', '-app.').replace(/^admin\./, '');
  return `${window.location.protocol}//${host}`;
}

// ---------------------------------------------------------------------------
// Parent CRUD
// ---------------------------------------------------------------------------

export async function listBroadcasts(): Promise<Broadcast[]> {
  const { data, error } = await supabase
    .from('broadcasts')
    .select('*, sends:broadcast_sends(id, broadcast_id, status, schedule_type, delivery_strategy, scheduled_at, total_recipients, sent_count, failed_count, created_at)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Broadcast[];
}

export async function getBroadcast(id: string): Promise<Broadcast | null> {
  const { data, error } = await supabase.from('broadcasts').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as Broadcast) ?? null;
}

export async function createBroadcast(input: CreateBroadcastInput): Promise<Broadcast> {
  const { data, error } = await supabase
    .from('broadcasts')
    .insert({
      name: input.name,
      brand: input.brand ?? 'default',
      audience_type: input.audience_type ?? 'segment',
      segment_id: input.segment_id ?? null,
      list_ids: input.list_ids ?? [],
      subject: input.subject ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as Broadcast;
}

export async function updateBroadcast(id: string, patch: Partial<Broadcast>): Promise<Broadcast> {
  const { data, error } = await supabase.from('broadcasts').update(patch).eq('id', id).select('*').single();
  if (error) throw error;
  return data as Broadcast;
}

export async function deleteBroadcast(id: string): Promise<void> {
  const { error } = await supabase.from('broadcasts').delete().eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Send instances
// ---------------------------------------------------------------------------

/** Create a send instance from the broadcast parent + composer config. The
 *  instance snapshots the parent's content/audience so the worker binding (which
 *  reads broadcast_sends) is unchanged. The SendingPanel then triggers the
 *  immediate send (broadcast-send edge fn) or leaves it scheduled for the cron. */
export async function createBroadcastSend(parentId: string, config: SendComposerConfig): Promise<{ id: string }> {
  const parent = await getBroadcast(parentId);
  if (!parent) throw new Error('Broadcast not found');
  if (!parent.rendered_html) throw new Error('Add content before sending');
  // Mandatory: every broadcast is tied to a list so recipients can unsubscribe
  // from it (the send injects the unsubscribe footer for that list). No list → no send.
  if (!parent.category_list_id) throw new Error('Select an unsubscribe list before sending');

  // Bake the linked event's {{event_*}} variables into this send's snapshot.
  // These are constant per send (event details don't vary per recipient), so
  // they're substituted once here; per-recipient merge fields stay for send time.
  let subject = parent.subject;
  let renderedHtml = parent.rendered_html;
  if (parent.event_id) {
    const { data: ev } = await supabase
      .from('events')
      .select('event_title, event_slug, event_id, event_start, event_city')
      .eq('id', parent.event_id)
      .maybeSingle();
    if (ev) {
      const values = eventVarValues(ev as Parameters<typeof eventVarValues>[0], portalBaseFromAdmin());
      if (subject) subject = substituteEventVars(subject, values);
      if (renderedHtml) renderedHtml = substituteEventVars(renderedHtml, values);
    }
  }

  const { data, error } = await supabase
    .from('broadcast_sends')
    .insert({
      broadcast_id: parentId,
      event_id: parent.event_id,
      name: parent.name,
      brand: parent.brand,
      channel: parent.channel,
      audience_type: parent.audience_type,
      segment_id: parent.segment_id,
      list_ids: parent.list_ids,
      category_list_id: parent.category_list_id,
      subject,
      preheader: parent.preheader,
      from_address: parent.from_address,
      from_name: parent.from_name,
      reply_to: parent.reply_to,
      rendered_html: renderedHtml,
      body_text: parent.body_text,
      content_json: parent.content_json,
      suppression_topic: 'broadcasts',
      status: config.scheduleType === 'scheduled' ? 'scheduled' : 'sending',
      schedule_type: config.scheduleType,
      scheduled_at: config.scheduledAt,
      delivery_strategy: config.deliveryStrategy,
      target_local: config.targetLocal,
      default_timezone: config.defaultTimezone,
      exclude_sent_send_ids: config.excludeSentSendIds.length > 0 ? config.excludeSentSendIds : null,
      total_recipients: 0, sent_count: 0, failed_count: 0,
      // Portal base for the send's unsubscribe/manage-preferences footer links —
      // like newsletters, so they open the portal Subscription Centre
      // ({portal}/subscriptions?token=…) instead of the raw edge-fn URL.
      metadata: { portal_base_url: portalBaseFromAdmin() },
    })
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id as string };
}

export async function getTimezoneBreakdown(id: string): Promise<TimezoneBreakdownRow[]> {
  const { data, error } = await supabase.rpc('broadcast_send_timezone_breakdown', { p_send_id: id });
  if (error) throw error;
  return (data ?? []) as TimezoneBreakdownRow[];
}

// ---------------------------------------------------------------------------
// AI segment copilot (unchanged — Node-side route via the AI module's runChat)
// ---------------------------------------------------------------------------

const API_URL = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';

export async function buildSegmentFromPrompt(
  prompt: string,
  opts?: { brand?: string; currentDefinition?: SegmentDefinition | null },
): Promise<CopilotResult> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_URL}/api/admin/modules/broadcasts/segments-ai-build`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt, brand: opts?.brand, current_definition: opts?.currentDefinition ?? undefined }),
    });
    const body = (await res.json().catch(() => ({}))) as CopilotResult;
    if (!res.ok) return { success: false, error: body?.error || `Copilot failed (${res.status})` };
    return body;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Copilot request failed' };
  }
}
