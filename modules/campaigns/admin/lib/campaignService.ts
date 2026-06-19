import { supabase } from '@/lib/supabase';
import type { SegmentDefinition } from '@/lib/segments';

// ---------------------------------------------------------------------------
// Campaign types (mirror public.campaign_sends)
// ---------------------------------------------------------------------------

export type CampaignStatus =
  | 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelling' | 'cancelled' | 'failed' | 'paused';
export type AudienceType = 'segment' | 'list';
export type DeliveryStrategy = 'global' | 'tz_local' | 'personalised';

export interface CampaignSend {
  id: string;
  name: string;
  brand: string;
  channel: 'email';
  audience_type: AudienceType;
  segment_id: string | null;
  list_ids: string[];
  subject: string | null;
  preheader: string | null;
  from_address: string | null;
  from_name: string | null;
  reply_to: string | null;
  rendered_html: string | null;
  body_text: string | null;
  content_json: Record<string, unknown>;
  suppression_topic: string;
  status: CampaignStatus;
  schedule_type: 'immediate' | 'scheduled';
  delivery_strategy: DeliveryStrategy;
  default_timezone: string | null;
  target_local: string | null;
  lead_minutes: number;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  exclude_sent_send_ids: string[] | null;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateCampaignInput {
  name: string;
  brand?: string;
  audience_type?: AudienceType;
  segment_id?: string | null;
  list_ids?: string[];
  subject?: string;
  suppression_topic?: string;
}

export interface TimezoneBreakdownRow {
  timezone: string;
  recipients: number;
  sent: number;
  failed: number;
  pending: number;
  skipped: number;
  send_at: string;
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

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listCampaigns(): Promise<CampaignSend[]> {
  const { data, error } = await supabase
    .from('campaign_sends')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as CampaignSend[];
}

export async function getCampaign(id: string): Promise<CampaignSend | null> {
  const { data, error } = await supabase.from('campaign_sends').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as CampaignSend) ?? null;
}

export async function createCampaign(input: CreateCampaignInput): Promise<CampaignSend> {
  const { data, error } = await supabase
    .from('campaign_sends')
    .insert({
      name: input.name,
      brand: input.brand ?? 'default',
      audience_type: input.audience_type ?? 'segment',
      segment_id: input.segment_id ?? null,
      list_ids: input.list_ids ?? [],
      subject: input.subject ?? null,
      suppression_topic: input.suppression_topic ?? 'campaigns',
      status: 'draft',
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as CampaignSend;
}

export async function updateCampaign(id: string, patch: Partial<CampaignSend>): Promise<CampaignSend> {
  const { data, error } = await supabase.from('campaign_sends').update(patch).eq('id', id).select('*').single();
  if (error) throw error;
  return data as CampaignSend;
}

export async function deleteCampaign(id: string): Promise<void> {
  const { error } = await supabase.from('campaign_sends').delete().eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Send lifecycle (via the campaign-send edge function)
// ---------------------------------------------------------------------------

/** Schedule a campaign: set scheduling fields + flip to 'scheduled'. The
 *  dispatch cron fans it out + drips when due. For immediate sends, set
 *  scheduled_at = now so the next tick picks it up (or call sendNow). */
export async function scheduleCampaign(id: string, opts: {
  schedule_type: 'immediate' | 'scheduled';
  delivery_strategy: DeliveryStrategy;
  scheduled_at?: string | null;
  default_timezone?: string | null;
  target_local?: string | null;
}): Promise<CampaignSend> {
  return updateCampaign(id, {
    status: 'scheduled',
    schedule_type: opts.schedule_type,
    delivery_strategy: opts.delivery_strategy,
    scheduled_at: opts.scheduled_at ?? new Date().toISOString(),
    default_timezone: opts.default_timezone ?? null,
    target_local: opts.target_local ?? null,
  } as Partial<CampaignSend>);
}

/** Fan out + start a campaign immediately (bypasses waiting for the cron). */
export async function sendNow(id: string): Promise<{ success: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke('campaign-send', { body: { send_id: id } });
  if (error) return { success: false, error: error.message };
  return data as { success: boolean; error?: string };
}

export async function sendTest(id: string, email: string): Promise<{ success: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke('campaign-send', { body: { test_send: { send_id: id, email } } });
  if (error) return { success: false, error: error.message };
  return data as { success: boolean; error?: string };
}

export async function pauseCampaign(id: string): Promise<void> { await updateCampaign(id, { status: 'paused' } as Partial<CampaignSend>); }
export async function resumeCampaign(id: string): Promise<void> { await updateCampaign(id, { status: 'sending' } as Partial<CampaignSend>); }
export async function cancelCampaign(id: string): Promise<void> { await updateCampaign(id, { status: 'cancelling' } as Partial<CampaignSend>); }

export async function getTimezoneBreakdown(id: string): Promise<TimezoneBreakdownRow[]> {
  const { data, error } = await supabase.rpc('campaign_send_timezone_breakdown', { p_send_id: id });
  if (error) throw error;
  return (data ?? []) as TimezoneBreakdownRow[];
}

// ---------------------------------------------------------------------------
// AI segment copilot
// ---------------------------------------------------------------------------

const API_URL = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';

/** Calls the Node-side copilot route (which uses the AI module's runChat), not a
 *  Supabase edge function — the AI module is not Deno-compatible. Mirrors
 *  editor-ai-copilot's authedFetch pattern. */
export async function buildSegmentFromPrompt(prompt: string, brand?: string): Promise<CopilotResult> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_URL}/api/admin/modules/campaigns/segments-ai-build`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt, brand }),
    });
    const body = (await res.json().catch(() => ({}))) as CopilotResult;
    if (!res.ok) return { success: false, error: body?.error || `Copilot failed (${res.status})` };
    return body;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Copilot request failed' };
  }
}
