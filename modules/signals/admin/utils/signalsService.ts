import { supabase } from '@/lib/supabase';

export interface SignalsRule {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'paused';
  definition: Record<string, any>;
  created_by: string | null;
  version: number;
  last_evaluated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SignalsFire {
  id: string;
  rule_id: string;
  person_id: string | null;
  content_type: string;
  content_href: string;
  content_title: string;
  channel: string;
  score: number;
  status: string;
  error: string | null;
  created_at: string;
  dispatched_at: string | null;
}

export interface SignalsRuleStats {
  rule_id: string;
  name: string;
  status: string;
  fires: number;
  dispatched: number;
  failed: number;
  suppressed: number;
  outcomes: number;
  clicks: number;
  last_fire_at: string | null;
  last_evaluated_at: string | null;
}

interface ServiceResponse<T> { success: boolean; data?: T; error?: string }

async function run<T>(q: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<ServiceResponse<T>> {
  try {
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return { success: true, data: data as T };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export class SignalsService {
  static rules() {
    return run<SignalsRule[]>(supabase.from('signals_rules').select('*').order('created_at', { ascending: false }));
  }

  static createRule(input: { name: string; description: string | null; definition: Record<string, any>; status: string }) {
    return run<SignalsRule>(supabase.from('signals_rules').insert({ ...input, created_by: 'admin' }).select().single());
  }

  static updateRule(id: string, input: Partial<Pick<SignalsRule, 'name' | 'description' | 'definition' | 'status'>>) {
    return run<SignalsRule>(supabase.from('signals_rules').update({ ...input, updated_at: new Date().toISOString() }).eq('id', id).select().single());
  }

  static deleteRule(id: string) {
    return run<null>(supabase.from('signals_rules').delete().eq('id', id).then(({ error }) => ({ data: null, error })) as any);
  }

  /** Clearing last_evaluated_at makes the rule due on the next worker tick. */
  static markDue(id: string) {
    return run<SignalsRule>(supabase.from('signals_rules').update({ last_evaluated_at: null }).eq('id', id).select().single());
  }

  static fires(ruleId?: string) {
    let q = supabase.from('signals_fires').select('*').order('created_at', { ascending: false }).limit(100);
    if (ruleId) q = q.eq('rule_id', ruleId);
    return run<SignalsFire[]>(q);
  }

  static stats() {
    return run<SignalsRuleStats[]>(supabase.from('signals_rule_stats').select('*').order('fires', { ascending: false }));
  }
}
