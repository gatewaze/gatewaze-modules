/**
 * Speakers Rollup Service
 *
 * Wraps the speakers directory + talk pool + promote-to-event flow.
 * Separate from the legacy calendarService/eventSpeakersService so the
 * rollup features are clearly delineated.
 */

import { supabase } from '@/lib/supabase';

export type TalkScope = 'event' | 'calendar' | 'platform';
export type TalkStatus = 'pending' | 'accepted' | 'held' | 'declined' | 'scheduled' | 'withdrawn';

export interface SpeakerProfile {
  id: string;
  canonical_profile_id: string | null;
  person_id: string | null;
  name: string;
  email: string | null;
  title: string | null;
  company: string | null;
  bio: string | null;
  avatar_url: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
  website_url: string | null;
  topics: string[];
  availability_notes: string | null;
  is_active: boolean;
}

export interface Talk {
  id: string;
  event_uuid: string | null;
  calendar_id: string | null;
  origin_calendar_id: string | null;
  scope: TalkScope;
  title: string;
  synopsis: string | null;
  duration_minutes: number;
  status: TalkStatus;
  topics: string[];
  available_from: string | null;
  available_until: string | null;
  submitter_email: string | null;
  submitter_name: string | null;
  submitted_at: string;
  reviewed_at: string | null;
}

export interface CalendarTalkPoolRow {
  id: string;
  calendar_id: string;
  origin_calendar_id: string | null;
  title: string;
  synopsis: string | null;
  duration_minutes: number;
  topics: string[];
  status: TalkStatus;
  submitted_at: string;
  speaker_profile_id: string | null;
  speaker_name: string | null;
  speaker_email: string | null;
  speaker_company: string | null;
}

export interface ServiceResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export class SpeakersRollupService {
  // --------------------------------------------------------------------------
  // Speaker directory
  // --------------------------------------------------------------------------
  static async listSpeakers(
    opts: { search?: string; limit?: number; offset?: number } = {}
  ): Promise<ServiceResponse<{ speakers: SpeakerProfile[]; total: number }>> {
    try {
      const limit = opts.limit ?? 50;
      const offset = opts.offset ?? 0;

      let query = supabase
        .from('events_speaker_profiles')
        .select('*', { count: 'exact' })
        .is('canonical_profile_id', null)
        .eq('is_active', true)
        .order('name')
        .range(offset, offset + limit - 1);

      if (opts.search) {
        query = query.or(
          `name.ilike.%${opts.search}%,email.ilike.%${opts.search}%,company.ilike.%${opts.search}%`
        );
      }

      const { data, error, count } = await query;
      if (error) return { success: false, error: error.message };

      return {
        success: true,
        data: {
          speakers: (data || []) as SpeakerProfile[],
          total: count ?? data?.length ?? 0,
        },
      };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  static async getSpeaker(id: string): Promise<ServiceResponse<SpeakerProfile>> {
    try {
      const { data, error } = await supabase
        .from('events_speaker_profiles')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) return { success: false, error: error.message };
      if (!data) return { success: false, error: 'Speaker not found' };
      return { success: true, data: data as SpeakerProfile };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  // --------------------------------------------------------------------------
  // Talks (calendar pool + cross-calendar pool)
  // --------------------------------------------------------------------------
  static async getCalendarTalkPool(
    calendarId: string,
    opts: { status?: TalkStatus; limit?: number; offset?: number } = {}
  ): Promise<ServiceResponse<CalendarTalkPoolRow[]>> {
    try {
      const limit = opts.limit ?? 100;
      const offset = opts.offset ?? 0;

      let query = supabase
        .from('calendar_talk_pool')
        .select('*')
        .eq('calendar_id', calendarId)
        .order('submitted_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (opts.status) {
        query = query.eq('status', opts.status);
      }

      const { data, error } = await query;
      if (error) return { success: false, error: error.message };

      return { success: true, data: (data || []) as CalendarTalkPoolRow[] };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  static async listCrossCalendarTalks(
    opts: { scope?: TalkScope | 'all'; status?: TalkStatus; limit?: number; offset?: number } = {}
  ): Promise<ServiceResponse<Talk[]>> {
    try {
      const limit = opts.limit ?? 100;
      const offset = opts.offset ?? 0;

      let query = supabase
        .from('events_talks')
        .select('*')
        .order('submitted_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (opts.scope && opts.scope !== 'all') {
        query = query.eq('scope', opts.scope);
      }
      if (opts.status) {
        query = query.eq('status', opts.status);
      }

      const { data, error } = await query;
      if (error) return { success: false, error: error.message };

      return { success: true, data: (data || []) as Talk[] };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  static async updateTalkStatus(
    talkId: string,
    status: TalkStatus,
    reviewedBy?: string
  ): Promise<ServiceResponse<void>> {
    try {
      const patch: Record<string, unknown> = {
        status,
        reviewed_at: new Date().toISOString(),
      };
      if (reviewedBy) patch.reviewed_by = reviewedBy;

      const { error } = await supabase
        .from('events_talks')
        .update(patch)
        .eq('id', talkId);
      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  /**
   * Promote a held calendar talk to a specific event.
   */
  static async promoteTalkToEvent(
    talkId: string,
    eventUuid: string,
    preserveCalendarLink = true
  ): Promise<ServiceResponse<void>> {
    try {
      // Load the current talk
      const { data: talk, error: getErr } = await supabase
        .from('events_talks')
        .select('id, calendar_id, scope')
        .eq('id', talkId)
        .maybeSingle();
      if (getErr) return { success: false, error: getErr.message };
      if (!talk) return { success: false, error: 'Talk not found' };

      const patch: Record<string, unknown> = {
        event_uuid: eventUuid,
        scope: 'event',
        calendar_id: null, // must be null for scope='event'
        status: 'accepted',
      };
      if (preserveCalendarLink && (talk as any).calendar_id) {
        patch.origin_calendar_id = (talk as any).calendar_id;
      }

      const { error: updateErr } = await supabase
        .from('events_talks')
        .update(patch)
        .eq('id', talkId);
      if (updateErr) return { success: false, error: updateErr.message };

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  // --------------------------------------------------------------------------
  // Profile merge (super-admin only)
  // --------------------------------------------------------------------------
  static async mergeProfiles(
    canonicalId: string,
    aliasId: string
  ): Promise<ServiceResponse<void>> {
    try {
      if (canonicalId === aliasId) {
        return { success: false, error: 'Cannot merge a profile into itself' };
      }

      const { error } = await supabase
        .from('events_speaker_profiles')
        .update({ canonical_profile_id: canonicalId })
        .eq('id', aliasId)
        .is('canonical_profile_id', null); // don't chain aliases

      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }
}
