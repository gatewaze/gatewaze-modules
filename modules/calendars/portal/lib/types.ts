/**
 * Portal-side types for the calendars module.
 * Mirrors the admin/services types but kept separate so portal pages
 * have no admin code dependency.
 */

export interface Calendar {
  id: string
  calendar_id: string
  name: string
  description: string | null
  slug: string | null
  color: string | null
  logo_url: string | null
  cover_image_url: string | null
  visibility: 'public' | 'private' | 'unlisted'
  // About-page rich-text sections (HTML). Null when admin hasn't filled them in.
  about_organisers: string | null
  about_faq: string | null
  about_sponsors: string | null
}

export interface CalendarEvent {
  event_id: string
  event_slug: string | null
  event_title: string
  event_start: string | null
  event_end: string | null
  event_timezone: string | null
  event_city: string | null
  event_region: string | null
  event_country_code: string | null
  event_location: string | null
  venue_address: string | null
  event_description: string | null
  listing_intro: string | null
  event_logo: string | null
  screenshot_url: string | null
  gradient_color_1: string | null
  gradient_color_2: string | null
  gradient_color_3: string | null
  event_type: string | null
  event_topics: string[] | null
}

export interface CalendarWithEvents {
  calendar: Calendar
  upcoming: CalendarEvent[]
  past: CalendarEvent[]
  all: CalendarEvent[]
}

/**
 * Event row enriched with the rollup counts the timeline cards display.
 * Built by getCalendarEventTimeline — keep separate from CalendarEvent so the
 * cheap landing-page reads don't pay for the joins.
 */
export interface CalendarTimelineEvent extends CalendarEvent {
  uuid: string                  // events.id (uuid) — used as the join key for counts
  is_featured: boolean          // calendars_events.is_featured
  speaker_count: number
  registration_count: number    // non-cancelled registrations
  attended_count: number        // checked_in_at IS NOT NULL
  media_count: number
}

export interface CalendarEventTimeline {
  upcoming: CalendarTimelineEvent[]
  past: CalendarTimelineEvent[]
}

export interface CalendarRollupStats {
  totalEvents: number
  upcomingCount: number
  pastCount: number
  totalAttendees: number
  totalSpeakers: number
  totalMediaItems: number
  totalMembers: number
}

export interface CalendarMediaItem {
  id: string
  url: string
  thumbnail_url: string | null
  type: 'photo' | 'video' | 'image'
  caption: string | null
  event_id: string
  event_title: string
  event_slug: string | null
  created_at: string
}

export interface CalendarSubNavVisibility {
  media: boolean
  events: boolean
  join: boolean
  about: boolean
  chat: boolean
  leaderboard: boolean
  submitTalk: boolean
}
