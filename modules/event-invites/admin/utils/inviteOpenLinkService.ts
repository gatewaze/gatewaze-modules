import { supabase } from '@/lib/supabase';

export interface InviteOpenLink {
  id: string;
  event_id: string;
  sub_event_id: string | null;
  short_code: string;
  label: string | null;
  is_active: boolean;
  max_members_per_party: number;
  times_used: number;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

const BASE36 = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateShortCode(): string {
  const array = new Uint8Array(6);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => BASE36[b % 36]).join('');
}

export async function listOpenLinks(eventId: string): Promise<InviteOpenLink[]> {
  const { data, error } = await supabase
    .from('invite_open_links')
    .select('*')
    .eq('event_id', eventId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createOpenLink(input: {
  event_id: string;
  sub_event_id?: string | null;
  label?: string | null;
  max_members_per_party?: number;
  expires_at?: string | null;
}): Promise<InviteOpenLink> {
  // Generate a unique short code with retry on collision
  let shortCode = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    shortCode = generateShortCode();
    const { data: existing } = await supabase
      .from('invite_open_links')
      .select('id')
      .eq('short_code', shortCode)
      .maybeSingle();
    if (!existing) break;
    if (attempt === 2) throw new Error('Failed to generate unique short code after 3 attempts');
  }

  const { data, error } = await supabase
    .from('invite_open_links')
    .insert({
      event_id: input.event_id,
      sub_event_id: input.sub_event_id || null,
      short_code: shortCode,
      label: input.label || null,
      max_members_per_party: input.max_members_per_party ?? 10,
      expires_at: input.expires_at || null,
      is_active: true,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function updateOpenLink(
  id: string,
  updates: Partial<Pick<InviteOpenLink, 'label' | 'is_active' | 'max_members_per_party' | 'expires_at' | 'sub_event_id'>>,
): Promise<InviteOpenLink> {
  const { data, error } = await supabase
    .from('invite_open_links')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteOpenLink(id: string): Promise<void> {
  const { error } = await supabase
    .from('invite_open_links')
    .delete()
    .eq('id', id);
  if (error) throw error;
}
