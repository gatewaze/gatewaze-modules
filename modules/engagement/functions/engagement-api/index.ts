// @ts-nocheck — Deno edge function
/**
 * engagement-api
 *
 * Read endpoints for leaderboards + member engagement detail.
 * Auth via Supabase JWT; RLS enforces per-row access.
 *
 * Per spec-engagement-module.md §5.2, §5.4, §16.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, error: null }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
function err(status: number, code: string, message: string, details?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ data: null, error: { code, message, details } }),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

function getJwt(req: Request): string | null {
  const h = req.headers.get('Authorization') || req.headers.get('authorization')
  if (!h) return null
  const m = h.match(/^Bearer\s+(.+)$/)
  return m ? m[1] : null
}

async function getLeaderboard(supabase: any, calendarId: string, limit: number, offset: number): Promise<Response> {
  // Check leaderboard visibility
  const { data: settings } = await supabase
    .from('engagement_calendar_settings')
    .select('leaderboard_enabled, leaderboard_visibility, display_name_mode')
    .eq('calendar_id', calendarId)
    .maybeSingle()

  if (settings?.leaderboard_enabled === false || settings?.leaderboard_visibility === 'admin-only') {
    return err(404, 'NOT_FOUND', 'Leaderboard not available for this calendar.')
  }

  const { data: rows } = await supabase
    .from('engagement_scores_calendar')
    .select('person_id, total_points, event_count, last_active_at')
    .eq('calendar_id', calendarId)
    .order('total_points', { ascending: false })
    .range(offset, offset + limit - 1)

  if (!rows) return ok({ calendar_id: calendarId, entries: [] })

  // Resolve person display names based on display_name_mode
  const personIds = rows.map((r: any) => r.person_id)
  const { data: people } = await supabase
    .from('people')
    .select('id, attributes')
    .in('id', personIds)

  const { data: profiles } = await supabase
    .from('people_profiles')
    .select('id, username')
    .in('id', personIds)

  const peopleById = new Map<string, any>((people || []).map((p: any) => [p.id, p]))
  const profilesById = new Map<string, any>((profiles || []).map((p: any) => [p.id, p]))
  const mode = settings?.display_name_mode || 'first_name_initial'

  const entries = rows.map((row: any, idx: number) => {
    const person = peopleById.get(row.person_id)
    const profile = profilesById.get(row.person_id)
    const attrs = person?.attributes || {}
    const firstName = attrs.first_name || 'Member'
    const lastName = attrs.last_name || ''
    let displayName: string
    switch (mode) {
      case 'full_name':
        displayName = `${firstName} ${lastName}`.trim()
        break
      case 'username':
        displayName = profile?.username ? `@${profile.username}` : `${firstName} ${lastName ? lastName[0] + '.' : ''}`.trim()
        break
      case 'anonymous':
        displayName = `Member ${row.person_id.slice(0, 4)}`
        break
      case 'first_name_initial':
      default:
        displayName = `${firstName} ${lastName ? lastName[0] + '.' : ''}`.trim()
    }
    return {
      rank: offset + idx + 1,
      person_id: row.person_id,
      display_name: displayName,
      total_points: row.total_points,
      event_count: row.event_count,
      last_active_at: row.last_active_at,
    }
  })

  return ok({ calendar_id: calendarId, entries, pagination: { limit, offset, has_more: rows.length === limit } })
}

async function getMyEngagement(supabase: any): Promise<Response> {
  // Resolve auth person
  const { data: authRes } = await supabase.auth.getUser()
  if (!authRes?.user?.id) return err(401, 'UNAUTHENTICATED', 'Not signed in.')
  const { data: person } = await supabase
    .from('people')
    .select('id')
    .eq('auth_user_id', authRes.user.id)
    .maybeSingle()
  if (!person) return err(401, 'UNAUTHENTICATED', 'No person record.')

  const personId = (person as any).id

  const [globalResult, calendarResult, badgesResult, recentResult] = await Promise.all([
    supabase
      .from('engagement_scores_global')
      .select('total_points, event_count, calendar_count, last_active_at')
      .eq('person_id', personId)
      .maybeSingle(),
    supabase
      .from('engagement_scores_calendar')
      .select('calendar_id, total_points, event_count')
      .eq('person_id', personId)
      .order('total_points', { ascending: false }),
    supabase
      .from('engagement_member_badges')
      .select('id, badge_id, calendar_id, awarded_at, engagement_badges(slug, label, icon, color)')
      .eq('person_id', personId)
      .eq('is_revoked', false),
    supabase
      .from('engagement_events')
      .select('id, signal, points, occurred_at, event_id, calendar_id')
      .eq('person_id', personId)
      .order('occurred_at', { ascending: false })
      .limit(25),
  ])

  return ok({
    person_id: personId,
    global: globalResult.data || { total_points: 0, event_count: 0, calendar_count: 0 },
    calendars: calendarResult.data || [],
    badges: (badgesResult.data || []).map((b: any) => ({
      id: b.id,
      calendar_id: b.calendar_id,
      awarded_at: b.awarded_at,
      slug: b.engagement_badges?.slug,
      label: b.engagement_badges?.label,
      icon: b.engagement_badges?.icon,
      color: b.engagement_badges?.color,
    })),
    recent_events: recentResult.data || [],
  })
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const url = new URL(req.url)
  const path = url.pathname
    .replace(/^\/functions\/v1\/engagement-api/, '')
    .replace(/^\/engagement-api/, '') || '/'

  const jwt = getJwt(req)
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: jwt ? { headers: { Authorization: `Bearer ${jwt}` } } : {},
  })

  try {
    // GET /calendars/:id/leaderboard
    const leaderboardMatch = path.match(/^\/calendars\/([0-9a-f-]{36})\/leaderboard$/)
    if (leaderboardMatch && req.method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
      const offset = parseInt(url.searchParams.get('offset') || '0', 10)
      return await getLeaderboard(supabase, leaderboardMatch[1], limit, offset)
    }

    // GET /me/engagement
    if (path === '/me/engagement' && req.method === 'GET') {
      return await getMyEngagement(supabase)
    }

    return err(404, 'NOT_FOUND', `Unknown route: ${req.method} ${path}`)
  } catch (e: any) {
    console.error('[engagement-api] Unhandled error:', e)
    return err(500, 'INTERNAL', e?.message || 'Unexpected error')
  }
}

Deno.serve(handler)
