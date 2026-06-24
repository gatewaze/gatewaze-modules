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
  const { data, error } = await supabase
    .from('broadcast_sends')
    .insert({
      broadcast_id: parentId,
      name: parent.name,
      brand: parent.brand,
      channel: parent.channel,
      audience_type: parent.audience_type,
      segment_id: parent.segment_id,
      list_ids: parent.list_ids,
      category_list_id: parent.category_list_id,
      subject: parent.subject,
      preheader: parent.preheader,
      from_address: parent.from_address,
      from_name: parent.from_name,
      reply_to: parent.reply_to,
      rendered_html: parent.rendered_html,
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
      metadata: {},
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
