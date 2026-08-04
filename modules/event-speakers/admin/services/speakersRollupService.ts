/**
 * Speakers Rollup Service
 *
 * Wraps the speakers directory + talk pool + promote-to-event flow.
 * Separate from the legacy calendarService/eventSpeakersService so the
 * rollup features are clearly delineated.
 */

import { supabase } from '@/lib/supabase';
import {
  buildSpeakerListingQuery,
  speakerPageCount,
  type ListSpeakersOptions,
} from './speakerListingQuery';

export type {
  ListSpeakersOptions,
  SpeakerListingQuery,
  SpeakerSortColumn,
  SortDirection,
} from './speakerListingQuery';
export {
  SPEAKER_SORT_COLUMNS,
  DEFAULT_SPEAKER_SORT,
  DEFAULT_SPEAKER_PAGE_SIZE,
  MAX_SPEAKER_PAGE_SIZE,
  buildSpeakerListingQuery,
  speakerPageCount,
  defaultDirectionFor,
} from './speakerListingQuery';

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

/**
 * A directory row: the profile plus the event rollup from
 * `events_speaker_profiles_with_counts` (migration 012). Kept separate from
 * SpeakerProfile because `getSpeaker` reads the base table, which has neither
 * column.
 */
export interface SpeakerDirectoryRow extends SpeakerProfile {
  /** Distinct events this speaker appears on, scoped by the caller's RLS. */
  event_count: number;
  /** Those event ids — powers the "filter by event" control without an N+1. */
  event_uuids: string[];
}

export interface SpeakerDirectoryPage {
  speakers: SpeakerDirectoryRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
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
  /**
   * Paginated, sortable, filterable speaker directory.
   *
   * Reads `events_speaker_profiles_with_counts` (security_invoker), so
   * event_count and event_uuids are already scoped to what the caller's RLS
   * lets them see — there is no privileged path here and no per-row follow-up
   * query.
   *
   * Every user-controlled input is shaped by `buildSpeakerListingQuery`
   * first: the sort column comes from an allowlist, the direction is a
   * string union, eventId must be a uuid, and the search term has PostgREST
   * filter-grammar metacharacters stripped before it reaches `.or()`.
   */
  static async listSpeakers(
    opts: ListSpeakersOptions = {}
  ): Promise<ServiceResponse<SpeakerDirectoryPage>> {
    try {
      const q = buildSpeakerListingQuery(opts);

      let query = supabase
        .from('events_speaker_profiles_with_counts')
        .select('*', { count: 'exact' })
        .is('canonical_profile_id', null)
        .eq('is_active', true)
        .order(q.sort, { ascending: q.ascending })
        // Stable tiebreaker: without it, rows tied on the sort column (every
        // speaker with the same event_count, say) can be returned in a
        // different order per page and the same speaker shows up twice.
        .order('id', { ascending: true })
        .range(q.from, q.to);

      if (q.orFilter) {
        query = query.or(q.orFilter);
      }

      if (q.eventId) {
        query = query.overlaps('event_uuids', [q.eventId]);
      }

      const { data, error, count } = await query;
      if (error) return { success: false, error: error.message };

      const total = count ?? data?.length ?? 0;

      return {
        success: true,
        data: {
          speakers: (data || []) as SpeakerDirectoryRow[],
          total,
          page: q.page,
          pageSize: q.pageSize,
          pageCount: speakerPageCount(total, q.pageSize),
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
