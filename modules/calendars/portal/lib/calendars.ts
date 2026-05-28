// @ts-nocheck — portal deps are resolved at build time via webpack alias
/**
 * Server-side data helpers for the calendars module's portal pages.
 *
 * Each helper creates its own Supabase client from env vars so this file
 * has no dependency on the core portal's `@/lib/supabase/server` alias.
 */

import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type {
  Calendar,
  CalendarEvent,
  CalendarWithEvents,
  CalendarRollupStats,
  CalendarMediaItem,
  CalendarSubNavVisibility,
  CalendarTimelineEvent,
  CalendarEventTimeline,
} from './types'

// Core columns guaranteed by migration 001. About-* columns ship in
// migration 012 and are appended by ensureAboutFields() / fetched
// separately by callers if they're missing on this database.
const CALENDAR_CORE_SELECT_FIELDS =
  'id, calendar_id, name, description, slug, color, logo_url, cover_image_url, visibility'

const CALENDAR_SELECT_FIELDS =
  `${CALENDAR_CORE_SELECT_FIELDS}, about_organisers, about_faq, about_sponsors`

/**
 * Some Supabase / PostgREST errors don't serialise via console.log — their
 * fields are getters on the prototype. Log them explicitly so the diagnostic
 * isn't `{}` when something goes wrong.
 */
function describeSupabaseError(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== 'object') return { error: err }
  const e = err as any
  return {
    message: e.message,
    code: e.code,
    details: e.details,
    hint: e.hint,
    name: e.name,
  }
}

/**
 * PostgREST returns code "42703" (or a "column ... does not exist" message)
 * when a SELECT references a column the database hasn't grown yet. We use
 * this to fall back to the core column set if migration 012 hasn't been
 * applied — better to render the page without About content than to fail.
 */
function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as any
  if (e.code === '42703') return true
  const msg: string = e.message || e.hint || ''
  return /column .* does not exist/i.test(msg)
}

const EVENT_SELECT_FIELDS = `
  event_id,
  event_slug,
  event_title,
  event_start,
  event_end,
  event_timezone,
  event_city,
  event_region,
  event_country_code,
  event_location,
  venue_address,
  event_description,
  listing_intro,
  event_logo,
  screenshot_url,
  gradient_color_1,
  gradient_color_2,
  gradient_color_3,
  event_type,
  event_topics
`

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new Error('[calendars-portal] SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY required')
  }
  return createClient(url, key, {
    global: { fetch: (u, options = {}) => fetch(u, { ...options, cache: 'no-store' }) },
  })
}

/**
 * Auth-aware Supabase client: reads the user's session from request cookies
 * via @supabase/ssr. Used by viewer-identity helpers below so the calendar
 * portal pages can tailor what they show based on who is signed in.
 */
async function getAuthSupabase() {
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const internalUrl = process.env.SUPABASE_URL || publicUrl
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!publicUrl || !key) {
    throw new Error('[calendars-portal] SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY required')
  }
  const cookieStore = await cookies()
  return createServerClient(publicUrl, key, {
    cookies: {
      getAll() { return cookieStore.getAll() },
      setAll(toSet) {
        try {
          toSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        } catch {}
      },
    },
    ...(internalUrl !== publicUrl ? {
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          const u = typeof input === 'string'
            ? input
            : input instanceof URL ? input.toString() : (input as any).url
          return fetch(u.replace(publicUrl, internalUrl as string), init)
        },
      },
    } : {}),
  })
}

/**
 * Resolve the current viewer's people.id (or null when signed out).
 * Used to drive sub-nav visibility (member-gated tabs) and chat membership.
 */
export async function getViewerPersonId(): Promise<string | null> {
  try {
    const supabase = await getAuthSupabase()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null
    const { data: person } = await supabase
      .from('people')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle()
    return (person as any)?.id ?? null
  } catch {
    return null
  }
}

/**
 * Check whether the viewer is an active member of this calendar.
 */
export async function isViewerActiveMember(
  calendarId: string,
  viewerPersonId: string | null
): Promise<boolean> {
  if (!viewerPersonId) return false
  try {
    const supabase = getSupabase()
    const { data } = await supabase
      .from('calendars_members')
      .select('id')
      .eq('calendar_id', calendarId)
      .eq('person_id', viewerPersonId)
      .eq('membership_status', 'active')
      .maybeSingle()
    return !!data
  } catch {
    return false
  }
}

/**
 * Fetch all public, active calendars for the current brand.
 *
 * Tries the full select (including the about-* fields from migration 012);
 * if those columns don't exist yet, falls back to the core-only select so
 * the listing still works on databases pre-012.
 */
export async function getCalendars(): Promise<Calendar[]> {
  const supabase = getSupabase()

  const fullQuery = await supabase
    .from('calendars')
    .select(CALENDAR_SELECT_FIELDS)
    .eq('is_active', true)
    .eq('visibility', 'public')
    .order('name', { ascending: true })

  if (!fullQuery.error) return (fullQuery.data || []) as Calendar[]

  if (isMissingColumnError(fullQuery.error)) {
    console.warn(
      '[calendars-portal] getCalendars: about-* columns missing — falling back. Run `pnpm modules:migrate` to apply migration 012.'
    )
    const coreQuery = await supabase
      .from('calendars')
      .select(CALENDAR_CORE_SELECT_FIELDS)
      .eq('is_active', true)
      .eq('visibility', 'public')
      .order('name', { ascending: true })

    if (coreQuery.error) {
      console.error('[calendars-portal] getCalendars (fallback) failed:', describeSupabaseError(coreQuery.error))
      return []
    }
    return (coreQuery.data || []) as Calendar[]
  }

  console.error('[calendars-portal] getCalendars failed:', describeSupabaseError(fullQuery.error))
  return []
}

/**
 * Look up a calendar by its slug or calendar_id (e.g., "berlin-chapter" or "CAL-XXXX")
 * and return it together with all events linked to it via the calendars_events junction.
 */
export async function getCalendarWithEvents(identifier: string): Promise<CalendarWithEvents | null> {
  const supabase = getSupabase()

  // Same fallback strategy as getCalendars: try the full select first, drop
  // back to the core columns if migration 012 hasn't been applied yet.
  let calendar: any = null
  const fullQuery = await supabase
    .from('calendars')
    .select(CALENDAR_SELECT_FIELDS)
    .or(`slug.eq.${identifier},calendar_id.eq.${identifier}`)
    .eq('is_active', true)
    .eq('visibility', 'public')
    .maybeSingle()

  if (fullQuery.error && isMissingColumnError(fullQuery.error)) {
    console.warn(
      '[calendars-portal] getCalendarWithEvents: about-* columns missing — falling back. Run `pnpm modules:migrate` to apply migration 012.'
    )
    const coreQuery = await supabase
      .from('calendars')
      .select(CALENDAR_CORE_SELECT_FIELDS)
      .or(`slug.eq.${identifier},calendar_id.eq.${identifier}`)
      .eq('is_active', true)
      .eq('visibility', 'public')
      .maybeSingle()
    if (coreQuery.error) {
      console.error('[calendars-portal] getCalendarWithEvents (fallback) failed:', describeSupabaseError(coreQuery.error))
      return null
    }
    calendar = coreQuery.data
  } else if (fullQuery.error) {
    console.error('[calendars-portal] getCalendarWithEvents failed:', describeSupabaseError(fullQuery.error))
    return null
  } else {
    calendar = fullQuery.data
  }

  if (!calendar) return null

  const { data: rows, error: evErr } = await supabase
    .from('calendars_events')
    .select(`events!inner(${EVENT_SELECT_FIELDS})`)
    .eq('calendar_id', calendar.id)
    .eq('events.is_live_in_production', true)
    .limit(10000)

  if (evErr) {
    console.error('[calendars-portal] getCalendarWithEvents events fetch failed:', evErr)
  }

  const allEvents: CalendarEvent[] = (rows || []).map((row: any) => row.events)
  const now = new Date().toISOString()

  const upcoming = allEvents
    .filter((e) => !e.event_start || e.event_start >= now)
    .sort((a, b) => {
      if (!a.event_start) return 1
      if (!b.event_start) return -1
      return a.event_start.localeCompare(b.event_start)
    })

  const past = allEvents
    .filter((e) => e.event_start && e.event_start < now)
    .sort((a, b) => (b.event_start || '').localeCompare(a.event_start || ''))

  return {
    calendar: calendar as Calendar,
    upcoming,
    past,
    all: [...upcoming, ...past],
  }
}

/**
 * Pull the calendar's events plus per-event rollup counts (speakers,
 * registrations, attended, media) used by the rich Events timeline. The
 * landing-page helper above doesn't pay for these joins; this one does.
 *
 * Counts come from optional sister modules and are wrapped in try/catch so
 * the timeline still renders if a module isn't installed.
 */
export async function getCalendarEventTimeline(calendarId: string): Promise<CalendarEventTimeline> {
  const supabase = getSupabase()

  const { data: rows } = await supabase
    .from('calendars_events')
    .select(`
      is_featured,
      events!inner(
        id,
        ${EVENT_SELECT_FIELDS}
      )
    `)
    .eq('calendar_id', calendarId)
    .eq('events.is_live_in_production', true)
    .limit(2000)

  const enriched: CalendarTimelineEvent[] = []
  const eventByUuid = new Map<string, CalendarTimelineEvent>()

  for (const row of rows || []) {
    const ev: any = (row as any).events
    if (!ev?.id) continue
    const item: CalendarTimelineEvent = {
      ...(ev as CalendarEvent),
      uuid: ev.id,
      is_featured: !!(row as any).is_featured,
      speaker_count: 0,
      registration_count: 0,
      attended_count: 0,
      media_count: 0,
    }
    enriched.push(item)
    eventByUuid.set(ev.id, item)
  }

  const uuids = enriched.map((e) => e.uuid)

  if (uuids.length > 0) {
    // Speaker counts (event-speakers module). speakers are joined to events
    // via events_speakers.event_uuid (not event_id — see migration in the
    // event-speakers module). Confirmed status only — pending/declined
    // shouldn't be advertised.
    try {
      const { data: speakerRows } = await supabase
        .from('events_speakers')
        .select('event_uuid')
        .in('event_uuid', uuids)
        .eq('status', 'confirmed')
      for (const r of (speakerRows || []) as any[]) {
        const t = eventByUuid.get(r.event_uuid)
        if (t) t.speaker_count += 1
      }
    } catch {
      // events_speakers status column may not exist on older deployments;
      // fall back to the unfiltered count rather than zero.
      try {
        const { data: rawRows } = await supabase
          .from('events_speakers')
          .select('event_uuid')
          .in('event_uuid', uuids)
        for (const r of (rawRows || []) as any[]) {
          const t = eventByUuid.get(r.event_uuid)
          if (t) t.speaker_count += 1
        }
      } catch {}
    }

    try {
      const { data: regRows } = await supabase
        .from('events_registrations')
        .select('event_id, checked_in_at')
        .in('event_id', uuids)
        .neq('status', 'cancelled')
      for (const r of (regRows || []) as any[]) {
        const t = eventByUuid.get(r.event_id)
        if (!t) continue
        t.registration_count += 1
        if (r.checked_in_at) t.attended_count += 1
      }
    } catch {}

    try {
      const { data: mediaRows } = await supabase
        .from('events_media')
        .select('event_id')
        .in('event_id', uuids)
      for (const r of (mediaRows || []) as any[]) {
        const t = eventByUuid.get(r.event_id)
        if (t) t.media_count += 1
      }
    } catch {}
  }

  const now = new Date().toISOString()
  const upcoming = enriched
    .filter((e) => !e.event_start || e.event_start >= now)
    .sort((a, b) => {
      if (!a.event_start) return 1
      if (!b.event_start) return -1
      return a.event_start.localeCompare(b.event_start)
    })
  const past = enriched
    .filter((e) => e.event_start && e.event_start < now)
    .sort((a, b) => (b.event_start || '').localeCompare(a.event_start || ''))

  return { upcoming, past }
}

/**
 * Aggregate stats rollup for the calendar landing page hero + stats cards.
 *
 * One query per metric — kept simple. Can be merged into a single CTE if
 * latency budget pressure requires it (target p95 < 600ms per spec §19.1).
 */
export async function getCalendarRollupStats(calendarId: string): Promise<CalendarRollupStats> {
  const supabase = getSupabase()
  const now = new Date().toISOString()

  // Resolve event uuids linked to this calendar.
  const { data: linkRows } = await supabase
    .from('calendars_events')
    .select('event_id, events!inner(id, event_start)')
    .eq('calendar_id', calendarId)
    .eq('events.is_live_in_production', true)
    .limit(10000)

  const eventUuids: string[] = []
  let upcomingCount = 0
  let pastCount = 0
  for (const row of linkRows || []) {
    const ev: any = (row as any).events
    if (!ev) continue
    eventUuids.push(ev.id)
    if (!ev.event_start || ev.event_start >= now) upcomingCount++
    else pastCount++
  }

  const totalEvents = eventUuids.length

  // Counts that depend on related modules being installed: wrapped in
  // try/catch so the page still renders if a module is absent.
  let totalAttendees = 0
  let totalSpeakers = 0
  let totalMediaItems = 0
  let totalMembers = 0

  if (eventUuids.length > 0) {
    try {
      const { count } = await supabase
        .from('events_registrations')
        .select('id', { count: 'exact', head: true })
        .in('event_id', eventUuids)
        .neq('status', 'cancelled')
      totalAttendees = count || 0
    } catch {}

    try {
      // events_speakers uses event_uuid per the event-speakers module schema
      const { count } = await supabase
        .from('events_speakers')
        .select('id', { count: 'exact', head: true })
        .in('event_uuid', eventUuids)
      totalSpeakers = count || 0
    } catch {}

    try {
      const { count } = await supabase
        .from('events_media')
        .select('id', { count: 'exact', head: true })
        .in('event_id', eventUuids)
      totalMediaItems = count || 0
    } catch {}
  }

  try {
    const { count } = await supabase
      .from('calendars_members')
      .select('id', { count: 'exact', head: true })
      .eq('calendar_id', calendarId)
      .eq('membership_status', 'active')
    totalMembers = count || 0
  } catch {}

  return {
    totalEvents,
    upcomingCount,
    pastCount,
    totalAttendees,
    totalSpeakers,
    totalMediaItems,
    totalMembers,
  }
}

/**
 * Pull media highlights (photos + videos) for the calendar landing page
 * gallery and the dedicated /media sub-page.
 */
export async function getCalendarMediaHighlights(
  calendarId: string,
  opts: { limit?: number; type?: 'photo' | 'video' | 'all'; offset?: number } = {}
): Promise<CalendarMediaItem[]> {
  const supabase = getSupabase()
  const limit = opts.limit ?? 12
  const offset = opts.offset ?? 0

  // Resolve linked events first.
  const { data: linkRows } = await supabase
    .from('calendars_events')
    .select('events!inner(id, event_id, event_slug, event_title)')
    .eq('calendar_id', calendarId)
    .eq('events.is_live_in_production', true)
    .limit(10000)

  const eventByUuid = new Map<string, { event_id: string; event_slug: string | null; event_title: string }>()
  const eventUuids: string[] = []
  for (const row of linkRows || []) {
    const ev: any = (row as any).events
    if (!ev) continue
    eventUuids.push(ev.id)
    eventByUuid.set(ev.id, {
      event_id: ev.event_id,
      event_slug: ev.event_slug,
      event_title: ev.event_title,
    })
  }

  if (eventUuids.length === 0) return []

  // events_media schema (from event-media module 001):
  //   id, event_id (uuid FK to events.id), url, file_type ∈ {photo,video},
  //   caption, created_at. No thumbnail_url column.
  let query = supabase
    .from('events_media')
    .select('id, url, file_type, caption, event_id, created_at')
    .in('event_id', eventUuids)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (opts.type && opts.type !== 'all') {
    if (opts.type === 'photo') {
      query = query.eq('file_type', 'photo')
    } else {
      query = query.eq('file_type', 'video')
    }
  }

  const { data: mediaRows, error } = await query
  if (error) {
    console.error('[calendars-portal] getCalendarMediaHighlights failed:', error)
    return []
  }

  return (mediaRows || []).map((row: any) => {
    const ev = eventByUuid.get(row.event_id)
    const type: 'photo' | 'video' | 'image' = row.file_type === 'video' ? 'video' : 'photo'
    return {
      id: row.id,
      url: row.url,
      // events_media has no thumbnail column — fall back to the main url
      thumbnail_url: row.url,
      type,
      caption: row.caption,
      event_id: ev?.event_id || '',
      event_title: ev?.event_title || '',
      event_slug: ev?.event_slug || null,
      created_at: row.created_at,
    }
  })
}

/**
 * Count pending talks waiting in this calendar's talk pool. Used as social
 * proof on the home page Submit-Talk CTA. Returns 0 if the events_talks
 * table doesn't exist (event-speakers module not installed).
 */
export async function getCalendarPendingTalkCount(calendarId: string): Promise<number> {
  const supabase = getSupabase()
  try {
    const { count } = await supabase
      .from('events_talks')
      .select('id', { count: 'exact', head: true })
      .eq('calendar_id', calendarId)
      .eq('status', 'pending')
    return count || 0
  } catch {
    return 0
  }
}

/**
 * Compute which sub-nav entries should appear for a given calendar + viewer.
 * Computed server-side in one round-trip during the page's data fetch
 * (per spec §6.4 + §19.1).
 */
export async function getCalendarSubNavVisibility(
  calendarId: string,
  viewerPersonId: string | null
): Promise<CalendarSubNavVisibility> {
  const supabase = getSupabase()

  // Cheap counts via head queries
  let totalEvents = 0
  let totalMedia = 0
  let isMember = false

  try {
    const { count } = await supabase
      .from('calendars_events')
      .select('event_id', { count: 'exact', head: true })
      .eq('calendar_id', calendarId)
    totalEvents = count || 0
  } catch {}

  if (totalEvents > 0) {
    try {
      // Resolve event uuids again — small extra query, kept simple
      const { data: linkRows } = await supabase
        .from('calendars_events')
        .select('events!inner(id)')
        .eq('calendar_id', calendarId)
        .eq('events.is_live_in_production', true)
        .limit(10000)
      const uuids = (linkRows || []).map((r: any) => r.events.id).filter(Boolean)
      if (uuids.length > 0) {
        const { count } = await supabase
          .from('events_media')
          .select('id', { count: 'exact', head: true })
          .in('event_id', uuids)
        totalMedia = count || 0
      }
    } catch {}
  }

  if (viewerPersonId) {
    try {
      const { data } = await supabase
        .from('calendars_members')
        .select('id')
        .eq('calendar_id', calendarId)
        .eq('person_id', viewerPersonId)
        .eq('membership_status', 'active')
        .maybeSingle()
      isMember = !!data
    } catch {}
  }

  // Chat tab visible only if the conversations module is installed (has a
  // calendar_channel for this calendar) AND the viewer is a signed-in member.
  let hasChat = false
  try {
    const { count } = await supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('calendar_id', calendarId)
      .eq('kind', 'calendar_channel')
      .eq('is_default', true)
    hasChat = (count || 0) > 0
  } catch {
    // conversations table may not exist if the module isn't installed
    hasChat = false
  }

  // Leaderboard tab visible only if the engagement module is installed
  // (has settings or any scored rows for this calendar) AND visibility
  // isn't admin-only.
  let hasLeaderboard = false
  try {
    const { data: settings } = await supabase
      .from('engagement_calendar_settings')
      .select('leaderboard_enabled, leaderboard_visibility')
      .eq('calendar_id', calendarId)
      .maybeSingle()
    if (settings) {
      hasLeaderboard =
        (settings as any).leaderboard_enabled !== false &&
        (settings as any).leaderboard_visibility !== 'admin-only'
    } else {
      const { count } = await supabase
        .from('engagement_scores_calendar')
        .select('person_id', { count: 'exact', head: true })
        .eq('calendar_id', calendarId)
      hasLeaderboard = (count || 0) > 0
    }
  } catch {
    // engagement tables may not exist
    hasLeaderboard = false
  }

  // Submit Talk tab visible if event-speakers module is installed
  let hasSubmitTalk = false
  try {
    const { data: mod } = await supabase
      .from('installed_modules')
      .select('status')
      .eq('id', 'event-speakers')
      .maybeSingle()
    hasSubmitTalk = mod?.status === 'enabled'
  } catch {
    hasSubmitTalk = false
  }

  return {
    media: totalMedia > 0,
    events: totalEvents > 0,
    join: !isMember,
    about: true,
    chat: hasChat && isMember,
    leaderboard: hasLeaderboard,
    submitTalk: hasSubmitTalk,
  }
}
