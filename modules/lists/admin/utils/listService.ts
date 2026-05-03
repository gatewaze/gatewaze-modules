import { supabase } from '@/lib/supabase';
import type { List, ListSubscription } from '../../types';

export class ListService {
  static async getAll(): Promise<{ data: List[] | null; error: any }> {
    try {
      const { data: lists, error } = await supabase
        .from('lists')
        .select('*')
        .order('name');

      if (error) return { data: null, error };

      // Get subscriber counts
      const { data: counts } = await supabase.rpc('lists_get_subscriber_counts');
      const countMap = new Map((counts || []).map((c: any) => [c.list_id, Number(c.subscriber_count)]));

      const result = (lists || []).map((list: any) => ({
        ...list,
        subscriber_count: countMap.get(list.id) || 0,
      }));

      return { data: result, error: null };
    } catch (error) {
      return { data: null, error };
    }
  }

  static async create(list: Partial<List>): Promise<{ data: List | null; error: any }> {
    const { data, error } = await supabase
      .from('lists')
      .insert(list)
      .select()
      .single();
    return { data, error };
  }

  static async update(id: string, updates: Partial<List>): Promise<{ data: List | null; error: any }> {
    const { data, error } = await supabase
      .from('lists')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    return { data, error };
  }

  static async delete(id: string): Promise<{ error: any }> {
    const { error } = await supabase.from('lists').delete().eq('id', id);
    return { error };
  }

  static async getSubscribers(listId: string): Promise<{ data: ListSubscription[] | null; error: any }> {
    const { data, error } = await supabase
      .from('list_subscriptions')
      .select('*')
      .eq('list_id', listId)
      .order('created_at', { ascending: false });
    return { data, error };
  }

  static async importSubscribers(listId: string, emails: string[]): Promise<{ count: number; error: any }> {
    const rows = emails
      .filter(e => e && e.includes('@'))
      .map(email => ({
        list_id: listId,
        email: email.toLowerCase().trim(),
        subscribed: true,
        subscribed_at: new Date().toISOString(),
        source: 'import',
      }));

    const { error } = await supabase
      .from('list_subscriptions')
      .upsert(rows, { onConflict: 'list_id,email' });

    return { count: rows.length, error };
  }
}
