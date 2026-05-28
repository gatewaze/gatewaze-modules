/**
 * Calendar Service
 * Handles all calendar-related CRUD operations
 */

import { supabase } from '@/lib/supabase';

// ============================================================================
// Types
// ============================================================================

/**
 * Calendar location settings
 * Used to associate a calendar with a geographic location (city, region, country)
 * or mark it as global (no specific location)
 */
export interface CalendarLocation {
  type: 'global' | 'city' | 'region' | 'country';
  city?: string;
  state?: string;        // US state or equivalent region
  country?: string;      // Full country name
  country_code?: string; // ISO 3166-1 alpha-2 code (e.g., 'US', 'GB')
  continent?: string;    // Continent name
}

export interface Calendar {
  id: string;
  calendarId: string;
  name: string;
  description?: string;
  slug?: string;
  color?: string;
  logoUrl?: string;
  coverImageUrl?: string;
  accountId?: string;
  visibility: 'public' | 'private' | 'unlisted';
  isActive: boolean;
  lumaCalendarId?: string;
  lumaWebhookSecret?: string;
  externalUrl?: string;
  defaultScraperId?: number;
  settings: Record<string, any>;
  metadata: Record<string, any>;
  // About-page rich-text sections (HTML produced by the admin Tiptap editor).
  aboutOrganisers?: string;
  aboutFaq?: string;
  aboutSponsors?: string;
  createdByAdminId?: string;
  createdAt: string;
  updatedAt: string;
  // Computed fields from views/joins
  eventCount?: number;
  memberCount?: number;
  upcomingEventCount?: number;
}

/**
 * Get the location settings from a calendar
 */
export function getCalendarLocation(calendar: Calendar): CalendarLocation | null {
  return calendar.settings?.location || null;
}

/**
 * Check if a calendar has a location set (not global)
 */
export function hasCalendarLocation(calendar: Calendar): boolean {
  const location = getCalendarLocation(calendar);
  return location !== null && location.type !== 'global';
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  eventId: string;
  sortOrder: number;
  isFeatured: boolean;
  addedVia: 'manual' | 'scraper' | 'import' | 'api';
  addedByAdminId?: string;
  addedAt: string;
  // Joined event fields
  event?: {
    eventTitle: string;
    eventStart: string;
    eventEnd: string;
    eventCity?: string;
    eventLogo?: string;
    // Luma attendance — present when the scrapers module has enriched this
    // event from __NEXT_DATA__. Used as the Guests/Tickets columns on the
    // calendar Events tab.
    lumaGuestCount?: number | null;
    lumaTicketCount?: number | null;
  };
}

export interface CalendarStats {
  total_members: number;
  total_events: number;
  upcoming_events: number;
  past_events: number;
  total_interested: number;
  total_registered: number;
  total_attended: number;
  // Luma attendance rollups — populated when the scrapers module is enabled
  // and events have been enriched from __NEXT_DATA__.
  total_luma_guests?: number;
  total_luma_tickets?: number;
  avg_luma_guests_all_time?: number;
  avg_luma_guests_6mo?: number;
  avg_luma_tickets_all_time?: number;
  avg_luma_tickets_6mo?: number;
  events_with_luma_data?: number;
  // Outlier-resistant metrics added in migration 011
  median_luma_guests_all_time?: number;
  median_luma_guests_6mo?: number;
  trimmed_mean_luma_guests_all_time?: number; // mean of middle 80% (10-90 percentile)
  trimmed_mean_luma_guests_6mo?: number;
  iqr_upper_luma_guests?: number | null; // Q3 + 1.5*IQR — flag outliers above this
}

export interface CalendarGuestTimelinePoint {
  event_id: string;
  event_title: string;
  event_start: string;
  luma_guest_count: number;
  is_outlier: boolean;
}

export interface CreateCalendarInput {
  name: string;
  description?: string;
  slug?: string;
  color?: string;
  logoUrl?: string;
  coverImageUrl?: string;
  accountId?: string;
  visibility?: 'public' | 'private' | 'unlisted';
  lumaCalendarId?: string;
  lumaWebhookSecret?: string;
  externalUrl?: string;
  defaultScraperId?: number;
  settings?: Record<string, any>;
  createdByAdminId?: string;
}

export interface UpdateCalendarInput {
  name?: string;
  description?: string;
  slug?: string;
  color?: string;
  logoUrl?: string;
  coverImageUrl?: string;
  accountId?: string;
  visibility?: 'public' | 'private' | 'unlisted';
  isActive?: boolean;
  lumaCalendarId?: string;
  lumaWebhookSecret?: string;
  externalUrl?: string;
  defaultScraperId?: number;
  settings?: Record<string, any>;
  aboutOrganisers?: string | null;
  aboutFaq?: string | null;
  aboutSponsors?: string | null;
}

export interface CalendarServiceResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Supabase / PostgREST errors don't serialise via console.log because their
 * fields live on getters. Dump the useful pieces explicitly.
 */
function describeSupabaseError(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== 'object') return { error: err };
  const e = err as any;
  return {
    message: e.message,
    code: e.code,
    details: e.details,
    hint: e.hint,
    name: e.name,
  };
}

/**
 * PostgREST returns code 42703 (and / or a "column ... does not exist"
 * message) when a query references a missing column. We use this to detect
 * pre-migration-012 databases and retry without the about-* fields.
 */
function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as any;
  if (e.code === '42703') return true;
  const msg: string = e.message || e.hint || e.details || '';
  return /column .* does not exist/i.test(msg);
}

// ============================================================================
// Field Mapping Helpers
// ============================================================================

function mapDbToCalendar(data: any): Calendar {
  return {
    id: data.id,
    calendarId: data.calendar_id,
    name: data.name,
    description: data.description,
    slug: data.slug,
    color: data.color,
    logoUrl: data.logo_url,
    coverImageUrl: data.cover_image_url,
    accountId: data.account_id,
    visibility: data.visibility,
    isActive: data.is_active,
    lumaCalendarId: data.luma_calendar_id,
    lumaWebhookSecret: data.luma_webhook_secret,
    externalUrl: data.external_url,
    defaultScraperId: data.default_scraper_id,
    settings: data.settings || {},
    metadata: data.metadata || {},
    aboutOrganisers: data.about_organisers ?? undefined,
    aboutFaq: data.about_faq ?? undefined,
    aboutSponsors: data.about_sponsors ?? undefined,
    createdByAdminId: data.created_by_admin_id,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    // Optional computed fields
    eventCount: data.event_count,
    memberCount: data.member_count,
    upcomingEventCount: data.upcoming_event_count,
  };
}

function mapCalendarToDb(calendar: CreateCalendarInput | UpdateCalendarInput): Record<string, any> {
  const dbFields: Record<string, any> = {};

  if ('name' in calendar && calendar.name !== undefined) dbFields.name = calendar.name;
  if ('description' in calendar) dbFields.description = calendar.description;
  if ('slug' in calendar) dbFields.slug = calendar.slug;
  if ('color' in calendar) dbFields.color = calendar.color;
  if ('logoUrl' in calendar) dbFields.logo_url = calendar.logoUrl;
  if ('coverImageUrl' in calendar) dbFields.cover_image_url = calendar.coverImageUrl;
  if ('accountId' in calendar) dbFields.account_id = calendar.accountId;
  if ('visibility' in calendar) dbFields.visibility = calendar.visibility;
  if ('isActive' in calendar) dbFields.is_active = calendar.isActive;
  if ('lumaCalendarId' in calendar) dbFields.luma_calendar_id = calendar.lumaCalendarId;
  if ('lumaWebhookSecret' in calendar) dbFields.luma_webhook_secret = calendar.lumaWebhookSecret;
  if ('externalUrl' in calendar) dbFields.external_url = calendar.externalUrl;
  if ('defaultScraperId' in calendar) dbFields.default_scraper_id = calendar.defaultScraperId;
  if ('settings' in calendar) dbFields.settings = calendar.settings;
  if ('aboutOrganisers' in calendar) dbFields.about_organisers = calendar.aboutOrganisers;
  if ('aboutFaq' in calendar) dbFields.about_faq = calendar.aboutFaq;
  if ('aboutSponsors' in calendar) dbFields.about_sponsors = calendar.aboutSponsors;
  if ('createdByAdminId' in calendar) dbFields.created_by_admin_id = calendar.createdByAdminId;

  return dbFields;
}

function mapDbToCalendarEvent(data: any): CalendarEvent {
  return {
    id: data.id,
    calendarId: data.calendar_id,
    eventId: data.event_id,
    sortOrder: data.sort_order,
    isFeatured: data.is_featured,
    addedVia: data.added_via,
    addedByAdminId: data.added_by_admin_id,
    addedAt: data.added_at,
    event: data.events ? {
      eventTitle: data.events.event_title,
      eventStart: data.events.event_start,
      eventEnd: data.events.event_end,
      eventCity: data.events.event_city,
      eventLogo: data.events.event_logo,
      lumaGuestCount: data.events.luma_guest_count ?? null,
      lumaTicketCount: data.events.luma_ticket_count ?? null,
    } : undefined,
  };
}

// ============================================================================
// CalendarService
// ============================================================================

export class CalendarService {
  // ==========================================================================
  // Calendar CRUD
  // ==========================================================================

  /**
   * Get a calendar by ID (UUID or calendar_id)
   */
  static async getCalendarById(id: string): Promise<CalendarServiceResponse<Calendar>> {
    try {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

      if (isUUID) {
        const { data, error } = await supabase
          .from('calendars')
          .select('*')
          .eq('id', id)
          .single();

        if (!error && data) return { success: true, data: mapDbToCalendar(data) };
      }

      // Try calendar_id (CAL-XXXXX), then slug
      for (const column of ['calendar_id', 'slug'] as const) {
        const { data, error } = await supabase
          .from('calendars')
          .select('*')
          .eq(column, id)
          .maybeSingle();

        if (!error && data) return { success: true, data: mapDbToCalendar(data) };
      }

      return { success: false, error: 'Calendar not found' };
    } catch (error) {
      console.error('Error in getCalendarById:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Get all calendars with optional filtering
   */
  static async getCalendars(options?: {
    accountId?: string;
    isActive?: boolean;
    visibility?: 'public' | 'private' | 'unlisted';
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<CalendarServiceResponse<{ calendars: Calendar[]; total: number }>> {
    try {
      let query = supabase
        .from('calendars')
        .select('*, calendars_events(count)', { count: 'exact' });

      if (options?.accountId) {
        query = query.eq('account_id', options.accountId);
      }

      if (options?.isActive !== undefined) {
        query = query.eq('is_active', options.isActive);
      }

      if (options?.visibility) {
        query = query.eq('visibility', options.visibility);
      }

      if (options?.search) {
        query = query.or(`name.ilike.%${options.search}%,description.ilike.%${options.search}%`);
      }

      query = query.order('created_at', { ascending: false });

      if (options?.limit) {
        query = query.limit(options.limit);
      }

      if (options?.offset) {
        query = query.range(options.offset, options.offset + (options.limit || 10) - 1);
      }

      const { data, error, count } = await query;

      if (error) {
        console.error('Error fetching calendars:', error);
        return { success: false, error: error.message };
      }

      // Get member counts using the database function (includes both direct members and registrations)
      const calendarIds = (data || []).map((item: any) => item.id);
      let memberCounts: Record<string, number> = {};

      if (calendarIds.length > 0) {
        const { data: countsData, error: countsError } = await supabase.rpc(
          'get_calendar_members_counts',
          { p_calendar_ids: calendarIds }
        );

        if (!countsError && countsData) {
          memberCounts = (countsData as Array<{ calendar_id: string; member_count: number }>).reduce(
            (acc, item) => {
              acc[item.calendar_id] = item.member_count;
              return acc;
            },
            {} as Record<string, number>
          );
        }
      }

      const calendars = (data || []).map((item: any) => ({
        ...mapDbToCalendar(item),
        eventCount: item.calendars_events?.[0]?.count || 0,
        memberCount: memberCounts[item.id] || 0,
      }));

      return { success: true, data: { calendars, total: count || 0 } };
    } catch (error) {
      console.error('Error in getCalendars:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Create a new calendar
   */
  static async createCalendar(input: CreateCalendarInput): Promise<CalendarServiceResponse<Calendar>> {
    try {
      if (!input.slug && input.name) {
        input.slug = input.name
          .trim()
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9 -]/g, '')
          .replace(/\s+/g, '-')
          .replace(/-+/g, '-');
      }
      const dbData = mapCalendarToDb(input);

      const { data, error } = await supabase
        .from('calendars')
        .insert(dbData)
        .select()
        .single();

      if (error) {
        console.error('Error creating calendar:', error);
        return { success: false, error: error.message };
      }

      return { success: true, data: mapDbToCalendar(data) };
    } catch (error) {
      console.error('Error in createCalendar:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Update a calendar
   *
   * If the UPDATE references columns the database hasn't grown yet (e.g.
   * about_organisers/about_faq/about_sponsors from migration 012), Postgres
   * rejects the whole statement and `.single()` surfaces the unhelpful
   * "Cannot coerce the result to a single JSON object" message. We retry
   * without those columns so the rest of the save still lands, then log a
   * warning so the operator knows to run `pnpm modules:migrate`.
   */
  static async updateCalendar(id: string, input: UpdateCalendarInput): Promise<CalendarServiceResponse<Calendar>> {
    try {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      const column = isUUID ? 'id' : 'calendar_id';
      const dbData = mapCalendarToDb(input);

      let { data, error } = await supabase
        .from('calendars')
        .update(dbData)
        .eq(column, id)
        .select()
        .single();

      if (error && isMissingColumnError(error)) {
        const stripped = { ...dbData };
        for (const k of ['about_organisers', 'about_faq', 'about_sponsors']) {
          delete stripped[k];
        }
        console.warn(
          '[calendars-admin] updateCalendar: about-* columns missing — retrying without them. Run `pnpm modules:migrate` to apply migration 012.'
        );
        const retry = await supabase
          .from('calendars')
          .update(stripped)
          .eq(column, id)
          .select()
          .single();
        data = retry.data;
        error = retry.error;
      }

      if (error) {
        console.error('Error updating calendar:', describeSupabaseError(error));
        return { success: false, error: error.message || 'Update failed.' };
      }

      return { success: true, data: mapDbToCalendar(data) };
    } catch (error) {
      console.error('Error in updateCalendar:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Delete a calendar (soft delete by setting is_active = false)
   */
  static async deleteCalendar(id: string): Promise<CalendarServiceResponse<void>> {
    try {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      const column = isUUID ? 'id' : 'calendar_id';

      const { error } = await supabase
        .from('calendars')
        .update({ is_active: false })
        .eq(column, id);

      if (error) {
        console.error('Error deleting calendar:', error);
        return { success: false, error: error.message };
      }

      return { success: true };
    } catch (error) {
      console.error('Error in deleteCalendar:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Permanently delete a calendar
   */
  static async hardDeleteCalendar(id: string): Promise<CalendarServiceResponse<void>> {
    try {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      const column = isUUID ? 'id' : 'calendar_id';

      const { error } = await supabase
        .from('calendars')
        .delete()
        .eq(column, id);

      if (error) {
        console.error('Error hard deleting calendar:', error);
        return { success: false, error: error.message };
      }

      return { success: true };
    } catch (error) {
      console.error('Error in hardDeleteCalendar:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  // ==========================================================================
  // Calendar Events Association
  // ==========================================================================

  /**
   * Helper to resolve calendar_id (CAL-XXX) to UUID
   */
  private static async resolveCalendarId(calendarId: string): Promise<{ uuid: string | null; error?: string }> {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(calendarId);
    if (isUUID) {
      return { uuid: calendarId };
    }

    // Try calendar_id (CAL-XXXXX), then slug
    for (const column of ['calendar_id', 'slug'] as const) {
      const { data: calendar } = await supabase
        .from('calendars')
        .select('id')
        .eq(column, calendarId)
        .maybeSingle();

      if (calendar) return { uuid: calendar.id };
    }

    return { uuid: null, error: 'Calendar not found' };
  }

  /**
   * Get events in a calendar
   */
  static async getCalendarEvents(
    calendarId: string,
    options?: {
      limit?: number;
      offset?: number;
      featured?: boolean;
      upcoming?: boolean;
    }
  ): Promise<CalendarServiceResponse<CalendarEvent[]>> {
    try {
      // Resolve calendar_id to UUID
      const { uuid, error: resolveError } = await this.resolveCalendarId(calendarId);
      if (!uuid) {
        return { success: false, error: resolveError };
      }

      let query = supabase
        .from('calendars_events')
        .select(`
          *,
          events (
            event_title,
            event_start,
            event_end,
            event_city,
            event_logo,
            luma_guest_count,
            luma_ticket_count
          )
        `)
        .eq('calendar_id', uuid)
        .order('sort_order', { ascending: true });

      if (options?.featured !== undefined) {
        query = query.eq('is_featured', options.featured);
      }

      if (options?.limit) {
        query = query.limit(options.limit);
      }

      if (options?.offset) {
        query = query.range(options.offset, options.offset + (options.limit || 10) - 1);
      }

      const { data, error } = await query;

      if (error) {
        console.error('Error fetching calendar events:', error);
        return { success: false, error: error.message };
      }

      let events = (data || []).map(mapDbToCalendarEvent);

      // Filter upcoming if requested (done in JS since we need join data)
      if (options?.upcoming) {
        const now = new Date().toISOString();
        events = events.filter(e => e.event && e.event.eventStart > now);
      }

      return { success: true, data: events };
    } catch (error) {
      console.error('Error in getCalendarEvents:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Add events to a calendar
   */
  static async addEventsToCalendar(
    calendarId: string,
    eventIds: string[],
    addedVia: 'manual' | 'scraper' | 'import' | 'api' = 'manual',
    addedByAdminId?: string
  ): Promise<CalendarServiceResponse<{ added: number; skipped: number }>> {
    try {
      // Resolve calendar_id to UUID
      const { uuid, error: resolveError } = await this.resolveCalendarId(calendarId);
      if (!uuid) {
        return { success: false, error: resolveError };
      }

      const records = eventIds.map(eventId => ({
        calendar_id: uuid,
        event_id: eventId,
        added_via: addedVia,
        added_by_admin_id: addedByAdminId,
      }));

      const { data, error } = await supabase
        .from('calendars_events')
        .upsert(records, { onConflict: 'calendar_id,event_id', ignoreDuplicates: true })
        .select();

      if (error) {
        console.error('Error adding events to calendar:', error);
        return { success: false, error: error.message };
      }

      return {
        success: true,
        data: {
          added: data?.length || 0,
          skipped: eventIds.length - (data?.length || 0),
        },
      };
    } catch (error) {
      console.error('Error in addEventsToCalendar:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Remove events from a calendar
   */
  static async removeEventsFromCalendar(
    calendarId: string,
    eventIds: string[]
  ): Promise<CalendarServiceResponse<{ removed: number }>> {
    try {
      // Resolve calendar_id to UUID
      const { uuid, error: resolveError } = await this.resolveCalendarId(calendarId);
      if (!uuid) {
        return { success: false, error: resolveError };
      }

      const { data, error } = await supabase
        .from('calendars_events')
        .delete()
        .eq('calendar_id', uuid)
        .in('event_id', eventIds)
        .select();

      if (error) {
        console.error('Error removing events from calendar:', error);
        return { success: false, error: error.message };
      }

      return { success: true, data: { removed: data?.length || 0 } };
    } catch (error) {
      console.error('Error in removeEventsFromCalendar:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Update event in calendar (featured status, sort order)
   */
  static async updateCalendarEvent(
    calendarId: string,
    eventId: string,
    updates: { isFeatured?: boolean; sortOrder?: number }
  ): Promise<CalendarServiceResponse<CalendarEvent>> {
    try {
      // Resolve calendar_id to UUID
      const { uuid, error: resolveError } = await this.resolveCalendarId(calendarId);
      if (!uuid) {
        return { success: false, error: resolveError };
      }

      const dbUpdates: Record<string, any> = {};
      if (updates.isFeatured !== undefined) dbUpdates.is_featured = updates.isFeatured;
      if (updates.sortOrder !== undefined) dbUpdates.sort_order = updates.sortOrder;

      const { data, error } = await supabase
        .from('calendars_events')
        .update(dbUpdates)
        .eq('calendar_id', uuid)
        .eq('event_id', eventId)
        .select()
        .single();

      if (error) {
        console.error('Error updating calendar event:', error);
        return { success: false, error: error.message };
      }

      return { success: true, data: mapDbToCalendarEvent(data) };
    } catch (error) {
      console.error('Error in updateCalendarEvent:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  // ==========================================================================
  // Calendar Stats
  // ==========================================================================

  /**
   * Get per-event guest timeline for the Reports tab charts. Each point is
   * an event with its date + guest count + whether it's a statistical outlier
   * (guest_count > Q3 + 1.5*IQR for this calendar). Only events with
   * guest_count > 0 are returned.
   */
  static async getCalendarGuestTimeline(calendarId: string): Promise<CalendarServiceResponse<CalendarGuestTimelinePoint[]>> {
    try {
      const { uuid, error: resolveError } = await this.resolveCalendarId(calendarId);
      if (!uuid) return { success: false, error: resolveError };

      const { data, error } = await supabase.rpc('get_calendar_guest_timeline', {
        p_calendar_id: uuid,
      });

      if (error) {
        console.error('Error fetching guest timeline:', error);
        return { success: false, error: error.message };
      }
      return { success: true, data: (data || []) as CalendarGuestTimelinePoint[] };
    } catch (error) {
      console.error('Error in getCalendarGuestTimeline:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Get calendar aggregate statistics
   */
  static async getCalendarStats(calendarId: string): Promise<CalendarServiceResponse<CalendarStats>> {
    try {
      // Resolve calendar_id to UUID
      const { uuid, error: resolveError } = await this.resolveCalendarId(calendarId);
      if (!uuid) {
        return { success: false, error: resolveError };
      }

      const { data, error } = await supabase.rpc('get_calendar_stats', {
        p_calendar_id: uuid,
      });

      if (error) {
        console.error('Error fetching calendar stats:', error);
        return { success: false, error: error.message };
      }

      return { success: true, data: data as CalendarStats };
    } catch (error) {
      console.error('Error in getCalendarStats:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Get events for a specific month (for calendar view)
   */
  static async getCalendarEventsForMonth(
    calendarId: string,
    year: number,
    month: number
  ): Promise<CalendarServiceResponse<any[]>> {
    try {
      // Resolve calendar_id to UUID
      const { uuid, error: resolveError } = await this.resolveCalendarId(calendarId);
      if (!uuid) {
        return { success: false, error: resolveError };
      }

      const startDate = new Date(year, month - 1, 1).toISOString();
      const endDate = new Date(year, month, 1).toISOString();

      const { data, error } = await supabase
        .from('calendars_events')
        .select('*, events(*)')
        .eq('calendar_id', uuid)
        .gte('events.event_start', startDate)
        .lt('events.event_start', endDate)
        .order('events(event_start)', { ascending: true });

      if (error) {
        console.error('Error fetching calendar events for month:', error);
        return { success: false, error: error.message };
      }

      return { success: true, data: data || [] };
    } catch (error) {
      console.error('Error in getCalendarEventsForMonth:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  // ==========================================================================
  // Scraper Association
  // ==========================================================================

  /**
   * Get scrapers associated with a calendar
   */
  static async getCalendarScrapers(calendarId: string): Promise<CalendarServiceResponse<any[]>> {
    try {
      // Resolve calendar_id to UUID
      const { uuid, error: resolveError } = await this.resolveCalendarId(calendarId);
      if (!uuid) {
        return { success: false, error: resolveError };
      }

      const { data, error } = await supabase
        .from('scrapers_calendars')
        .select(`
          *,
          scrapers (
            id,
            name,
            description,
            enabled,
            last_run
          )
        `)
        .eq('calendar_id', uuid)
        .eq('is_active', true);

      if (error) {
        console.error('Error fetching calendar scrapers:', error);
        return { success: false, error: error.message };
      }

      return { success: true, data: data || [] };
    } catch (error) {
      console.error('Error in getCalendarScrapers:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Associate a scraper with a calendar
   */
  static async addScraperToCalendar(
    calendarId: string,
    scraperId: number,
    autoAddEvents: boolean = true
  ): Promise<CalendarServiceResponse<void>> {
    try {
      // Resolve calendar_id to UUID
      const { uuid, error: resolveError } = await this.resolveCalendarId(calendarId);
      if (!uuid) {
        return { success: false, error: resolveError };
      }

      const { error } = await supabase
        .from('scrapers_calendars')
        .upsert({
          calendar_id: uuid,
          scraper_id: scraperId,
          is_active: true,
          auto_add_events: autoAddEvents,
        }, { onConflict: 'scraper_id,calendar_id' });

      if (error) {
        console.error('Error adding scraper to calendar:', error);
        return { success: false, error: error.message };
      }

      // Import existing events from this scraper
      if (autoAddEvents) {
        await this.importScraperEvents(calendarId, scraperId);
      }

      return { success: true };
    } catch (error) {
      console.error('Error in addScraperToCalendar:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Remove a scraper from a calendar
   */
  static async removeScraperFromCalendar(
    calendarId: string,
    scraperId: number
  ): Promise<CalendarServiceResponse<void>> {
    try {
      // Resolve calendar_id to UUID
      const { uuid, error: resolveError } = await this.resolveCalendarId(calendarId);
      if (!uuid) {
        return { success: false, error: resolveError };
      }

      const { error } = await supabase
        .from('scrapers_calendars')
        .update({ is_active: false })
        .eq('calendar_id', uuid)
        .eq('scraper_id', scraperId);

      if (error) {
        console.error('Error removing scraper from calendar:', error);
        return { success: false, error: error.message };
      }

      return { success: true };
    } catch (error) {
      console.error('Error in removeScraperFromCalendar:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Import all existing events from a scraper into a calendar
   */
  static async importScraperEvents(
    calendarId: string,
    scraperId: number
  ): Promise<CalendarServiceResponse<{ imported: number }>> {
    try {
      // Resolve calendar_id to UUID
      const { uuid, error: resolveError } = await this.resolveCalendarId(calendarId);
      if (!uuid) {
        return { success: false, error: resolveError };
      }

      // Get all events from this scraper. calendars_events.event_id is a
      // uuid FK to events.id, so select the uuid primary key (not the legacy
      // varchar event_id column).
      const { data: events, error: fetchError } = await supabase
        .from('events')
        .select('id')
        .eq('scraper_id', scraperId);

      if (fetchError) {
        console.error('Error fetching scraper events:', fetchError);
        return { success: false, error: fetchError.message };
      }

      if (!events || events.length === 0) {
        return { success: true, data: { imported: 0 } };
      }

      // Insert events into calendars_events (upsert to avoid duplicates)
      const records = events.map(event => ({
        calendar_id: uuid,
        event_id: event.id,
        added_via: 'scraper' as const,
      }));

      const { data: inserted, error: insertError } = await supabase
        .from('calendars_events')
        .upsert(records, { onConflict: 'calendar_id,event_id', ignoreDuplicates: true })
        .select();

      if (insertError) {
        console.error('Error importing scraper events:', insertError);
        return { success: false, error: insertError.message };
      }

      return { success: true, data: { imported: inserted?.length || 0 } };
    } catch (error) {
      console.error('Error in importScraperEvents:', error);
      return { success: false, error: (error as Error).message };
    }
  }
}

export default CalendarService;
