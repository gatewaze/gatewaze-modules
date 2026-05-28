import { supabase } from '@/lib/supabase';

export interface InviteTemplate {
  id: string;
  event_id: string;
  sub_event_id: string | null;
  channel: 'pdf' | 'email' | 'sms' | 'whatsapp';
  name: string;
  subject: string | null;
  body: string | null;
  pdf_background_path: string | null;
  pdf_background_hidden: boolean;
  pdf_fields: PdfField[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PdfField {
  type: 'text' | 'qr';
  variable?: string;        // variable path (e.g. 'party.name') — ignored if `text` is set
  text?: string;            // literal static text — when set, overrides `variable`
  x: number;
  y: number;
  rotation?: number;        // degrees, counter-clockwise (matches pdf-lib)
  fontSize?: number;        // supports decimals (e.g. 9.6)
  lineHeight?: number;      // multiplier applied to fontSize (default 1.0)
  fontAssetId?: string;
  color?: string;
  align?: 'left' | 'center' | 'right';
  maxWidth?: number;
  size?: number;            // for QR
}

export interface TemplateAsset {
  id: string;
  event_id: string;
  asset_type: 'font' | 'pdf_background';
  filename: string;
  storage_path: string;
  storage_bucket: string;
  mime_type: string | null;
  file_size: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface InviteDelivery {
  id: string;
  party_id: string;
  channel: string;
  template_id: string | null;
  status: string;
  sent_at: string | null;
  delivered_at: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// --- Template CRUD ---

export async function getTemplatesForEvent(eventId: string): Promise<InviteTemplate[]> {
  const { data, error } = await supabase
    .from('invite_templates')
    .select('*')
    .eq('event_id', eventId)
    .order('channel')
    .order('created_at');
  if (error) throw error;
  return data || [];
}

export async function getTemplate(id: string): Promise<InviteTemplate | null> {
  const { data, error } = await supabase
    .from('invite_templates')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
}

export async function createTemplate(template: Partial<InviteTemplate>): Promise<InviteTemplate> {
  const { data, error } = await supabase
    .from('invite_templates')
    .insert(template)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateTemplate(id: string, updates: Partial<InviteTemplate>): Promise<InviteTemplate> {
  const { data, error } = await supabase
    .from('invite_templates')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function duplicateTemplate(id: string): Promise<InviteTemplate> {
  const original = await getTemplate(id);
  if (!original) throw new Error('Template not found');
  // Strip server-managed fields and copy the rest
  const { id: _omitId, created_at: _omitCreated, updated_at: _omitUpdated, ...rest } = original;
  return await createTemplate({
    ...rest,
    name: `${original.name} (Copy)`,
    is_active: false,
  });
}

export async function deleteTemplate(id: string): Promise<void> {
  const { error } = await supabase
    .from('invite_templates')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// --- Asset Management ---

export async function getAssetsForEvent(eventId: string): Promise<TemplateAsset[]> {
  const { data, error } = await supabase
    .from('invite_template_assets')
    .select('*')
    .eq('event_id', eventId)
    .order('created_at');
  if (error) throw error;
  return data || [];
}

export async function uploadAsset(
  eventId: string,
  file: File,
  assetType: 'font' | 'pdf_background',
  metadata?: Record<string, unknown>,
): Promise<TemplateAsset> {
  const assetId = crypto.randomUUID();
  const ext = file.name.split('.').pop() || '';
  const storagePath = `${eventId}/${assetType === 'font' ? 'fonts' : 'backgrounds'}/${assetId}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from('invite-templates')
    .upload(storagePath, file, { upsert: false });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase
    .from('invite_template_assets')
    .insert({
      id: assetId,
      event_id: eventId,
      asset_type: assetType,
      filename: file.name,
      storage_path: storagePath,
      mime_type: file.type,
      file_size: file.size,
      metadata: metadata || {},
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteAsset(asset: TemplateAsset): Promise<void> {
  await supabase.storage.from(asset.storage_bucket).remove([asset.storage_path]);
  await supabase.from('invite_template_assets').delete().eq('id', asset.id);
}

export function getAssetPublicUrl(asset: TemplateAsset): string {
  const { data } = supabase.storage.from(asset.storage_bucket).getPublicUrl(asset.storage_path);
  return data.publicUrl;
}

// --- Template Matching ---

interface PartySubEventInfo {
  sub_event_ids: string[];
  primary_sub_event_id: string | null;
}

export async function getPartySubEvents(partyId: string): Promise<PartySubEventInfo> {
  const { data: members } = await supabase
    .from('invite_party_members')
    .select('id')
    .eq('party_id', partyId);

  if (!members?.length) return { sub_event_ids: [], primary_sub_event_id: null };

  const { data: memberEvents } = await supabase
    .from('invite_party_member_events')
    .select('sub_event_id')
    .in('party_member_id', members.map(m => m.id))
    .not('sub_event_id', 'is', null);

  const subEventIds = [...new Set((memberEvents || []).map(me => me.sub_event_id).filter(Boolean))];

  // Get first sub-event by sort_order
  let primaryId: string | null = null;
  if (subEventIds.length > 0) {
    const { data: subEvents } = await supabase
      .from('invite_sub_events')
      .select('id')
      .in('id', subEventIds)
      .order('sort_order')
      .limit(1);
    primaryId = subEvents?.[0]?.id || null;
  }

  return { sub_event_ids: subEventIds, primary_sub_event_id: primaryId };
}

export async function findMatchingTemplate(
  eventId: string,
  channel: string,
  primarySubEventId: string | null,
): Promise<InviteTemplate | null> {
  // Multiple active templates may exist for the same (event, sub_event,
  // channel) since the unique constraint was dropped to allow variants /
  // duplicates. Pick the most recently updated active one.
  if (primarySubEventId) {
    const { data } = await supabase
      .from('invite_templates')
      .select('*')
      .eq('event_id', eventId)
      .eq('sub_event_id', primarySubEventId)
      .eq('channel', channel)
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (data && data.length > 0) return data[0];
  }

  // Fall back to default (no sub-event) template
  const { data } = await supabase
    .from('invite_templates')
    .select('*')
    .eq('event_id', eventId)
    .is('sub_event_id', null)
    .eq('channel', channel)
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(1);
  return data && data.length > 0 ? data[0] : null;
}

// --- Delivery Log ---

export async function getDeliveriesForParty(partyId: string): Promise<InviteDelivery[]> {
  const { data, error } = await supabase
    .from('invite_deliveries')
    .select('*')
    .eq('party_id', partyId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getDeliveriesForParties(partyIds: string[]): Promise<InviteDelivery[]> {
  if (partyIds.length === 0) return [];

  // One UUID plus delimiter is ~37 chars. At ~250 ids the URL crosses 8 KB,
  // which the Supabase/Kong proxy rejects with no CORS headers — surfacing
  // as a preflight failure in the browser. Batch to stay well under that.
  const BATCH_SIZE = 50;
  const batches: string[][] = [];
  for (let i = 0; i < partyIds.length; i += BATCH_SIZE) {
    batches.push(partyIds.slice(i, i + BATCH_SIZE));
  }

  const results = await Promise.all(
    batches.map(batch =>
      supabase
        .from('invite_deliveries')
        .select('*')
        .in('party_id', batch)
        .order('created_at', { ascending: false })
    )
  );

  const out: InviteDelivery[] = [];
  for (const { data, error } of results) {
    if (error) throw error;
    if (data) out.push(...(data as InviteDelivery[]));
  }
  // Re-sort across batches so the combined list is newest-first.
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return out;
}

/**
 * Mark a (party, channel) pair as sent. Used for both auto logs (when the
 * system sends via an integrated channel) and manual logs (e.g. admin ticks
 * "posted" after physically mailing a printed invite).
 */
export async function markDeliverySent(
  partyId: string,
  channel: 'pdf' | 'email' | 'sms' | 'whatsapp',
  source: 'manual' | 'auto' = 'manual',
  templateId: string | null = null,
): Promise<InviteDelivery> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('invite_deliveries')
    .insert({
      party_id: partyId,
      channel,
      template_id: templateId,
      status: 'sent',
      sent_at: now,
      metadata: { source },
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Remove any existing "sent" deliveries for a (party, channel) pair. Used
 * when un-ticking a manually-marked cell in the Sending tracker.
 */
export async function clearDeliveryForChannel(
  partyId: string,
  channel: 'pdf' | 'email' | 'sms' | 'whatsapp',
): Promise<void> {
  const { error } = await supabase
    .from('invite_deliveries')
    .delete()
    .eq('party_id', partyId)
    .eq('channel', channel);
  if (error) throw error;
}

export async function createDelivery(delivery: Partial<InviteDelivery>): Promise<InviteDelivery> {
  const { data, error } = await supabase
    .from('invite_deliveries')
    .insert(delivery)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateDeliveryStatus(
  id: string,
  status: string,
  extra?: { error_message?: string; sent_at?: string; delivered_at?: string },
): Promise<void> {
  const { error } = await supabase
    .from('invite_deliveries')
    .update({ status, ...extra })
    .eq('id', id);
  if (error) throw error;
}
