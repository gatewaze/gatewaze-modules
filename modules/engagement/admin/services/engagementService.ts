/**
 * Engagement Service
 *
 * Wraps reads + writes for the engagement module's admin surfaces.
 */

import { supabase } from '@/lib/supabase';

export interface EngagementRule {
  id: string;
  signal: string;
  label: string;
  description: string | null;
  default_points: number;
  is_enabled: boolean;
  scope: 'global' | 'per_calendar' | 'per_event';
  cooldown_seconds: number | null;
  daily_cap: number | null;
}

export interface EngagementBadge {
  id: string;
  slug: string;
  label: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  rule_kind: 'count' | 'threshold' | 'manual' | 'first' | 'streak';
  rule_config: Record<string, unknown>;
  scope: 'global' | 'per_calendar';
  is_active: boolean;
  sort_order: number;
}

export interface LeaderboardEntry {
  rank: number;
  person_id: string;
  display_name: string;
  total_points: number;
  event_count: number;
  last_active_at: string | null;
}

export interface EngagementOverview {
  totalMembersTracked: number;
  totalEvents: number;
  totalEventsThisWeek: number;
  totalEventsThisMonth: number;
  badgesAwardedThisMonth: number;
  topCalendars: Array<{ calendar_id: string; total_points: number; member_count: number }>;
  topMembers: Array<{ person_id: string; total_points: number }>;
}

export interface ServiceResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export class EngagementService {
  // --------------------------------------------------------------------------
  // Overview
  // --------------------------------------------------------------------------
  static async getOverview(): Promise<ServiceResponse<EngagementOverview>> {
    try {
      const [totalEvents, totalMembersRes, weekRes, monthRes, badgesMonthRes, topMembersRes] = await Promise.all([
        supabase.from('engagement_events').select('id', { count: 'exact', head: true }),
        supabase.from('engagement_scores_global').select('person_id', { count: 'exact', head: true }),
        supabase
          .from('engagement_events')
          .select('id', { count: 'exact', head: true })
          .gte('occurred_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()),
        supabase
          .from('engagement_events')
          .select('id', { count: 'exact', head: true })
          .gte('occurred_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()),
        supabase
          .from('engagement_member_badges')
          .select('id', { count: 'exact', head: true })
          .gte('awarded_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()),
        supabase
          .from('engagement_scores_global')
          .select('person_id, total_points')
          .order('total_points', { ascending: false })
          .limit(10),
      ]);

      return {
        success: true,
        data: {
          totalMembersTracked: totalMembersRes.count || 0,
          totalEvents: totalEvents.count || 0,
          totalEventsThisWeek: weekRes.count || 0,
          totalEventsThisMonth: monthRes.count || 0,
          badgesAwardedThisMonth: badgesMonthRes.count || 0,
          topCalendars: [], // computed by a dedicated RPC in follow-up
          topMembers: (topMembersRes.data || []) as Array<{ person_id: string; total_points: number }>,
        },
      };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  // --------------------------------------------------------------------------
  // Rules
  // --------------------------------------------------------------------------
  static async listRules(): Promise<ServiceResponse<EngagementRule[]>> {
    try {
      const { data, error } = await supabase
        .from('engagement_rules')
        .select('*')
        .order('signal');
      if (error) return { success: false, error: error.message };
      return { success: true, data: (data || []) as EngagementRule[] };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  static async updateRule(id: string, patch: Partial<EngagementRule>): Promise<ServiceResponse<EngagementRule>> {
    try {
      const { data, error } = await supabase
        .from('engagement_rules')
        .update(patch)
        .eq('id', id)
        .select()
        .single();
      if (error) return { success: false, error: error.message };
      return { success: true, data: data as EngagementRule };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  // --------------------------------------------------------------------------
  // Badges
  // --------------------------------------------------------------------------
  static async listBadges(): Promise<ServiceResponse<EngagementBadge[]>> {
    try {
      const { data, error } = await supabase
        .from('engagement_badges')
        .select('*')
        .order('sort_order');
      if (error) return { success: false, error: error.message };
      return { success: true, data: (data || []) as EngagementBadge[] };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  static async createBadge(badge: Omit<EngagementBadge, 'id'>): Promise<ServiceResponse<EngagementBadge>> {
    try {
      const { data, error } = await supabase
        .from('engagement_badges')
        .insert(badge)
        .select()
        .single();
      if (error) return { success: false, error: error.message };
      return { success: true, data: data as EngagementBadge };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  static async awardBadge(
    badgeId: string,
    personId: string,
    calendarId: string | null,
    awardedBy: string,
    reason?: string
  ): Promise<ServiceResponse<void>> {
    try {
      const { error } = await supabase.from('engagement_member_badges').insert({
        badge_id: badgeId,
        person_id: personId,
        calendar_id: calendarId,
        awarded_by: awardedBy,
        reason,
      });
      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  // --------------------------------------------------------------------------
  // Leaderboard (admin-scoped read — calendar- or global-level)
  // --------------------------------------------------------------------------
  static async getCalendarLeaderboard(
    calendarId: string,
    limit = 50
  ): Promise<ServiceResponse<LeaderboardEntry[]>> {
    try {
      const { data, error } = await supabase
        .from('engagement_scores_calendar')
        .select('person_id, total_points, event_count, last_active_at')
        .eq('calendar_id', calendarId)
        .order('total_points', { ascending: false })
        .limit(limit);
      if (error) return { success: false, error: error.message };

      const entries: LeaderboardEntry[] = (data || []).map((row: any, idx: number) => ({
        rank: idx + 1,
        person_id: row.person_id,
        display_name: row.person_id.slice(0, 8), // admin view; resolution done in portal
        total_points: row.total_points,
        event_count: row.event_count,
        last_active_at: row.last_active_at,
      }));
      return { success: true, data: entries };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  static async getGlobalLeaderboard(limit = 100): Promise<ServiceResponse<LeaderboardEntry[]>> {
    try {
      const { data, error } = await supabase
        .from('engagement_scores_global')
        .select('person_id, total_points, event_count, last_active_at')
        .order('total_points', { ascending: false })
        .limit(limit);
      if (error) return { success: false, error: error.message };

      const entries: LeaderboardEntry[] = (data || []).map((row: any, idx: number) => ({
        rank: idx + 1,
        person_id: row.person_id,
        display_name: row.person_id.slice(0, 8),
        total_points: row.total_points,
        event_count: row.event_count,
        last_active_at: row.last_active_at,
      }));
      return { success: true, data: entries };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }
}
