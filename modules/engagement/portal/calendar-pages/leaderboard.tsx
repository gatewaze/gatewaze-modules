// @ts-nocheck — portal deps are resolved at build time via webpack alias
//
// Calendar microsite leaderboard sub-page content.
// Imported by the calendars module's portal/pages/[slug]/leaderboard.tsx
// which owns the route registration under /calendars/[slug]/leaderboard.

import Link from 'next/link'
import { createClient } from '@supabase/supabase-js'

interface Props {
  calendar: {
    id: string
    name: string
    slug: string | null
    calendar_id: string
  }
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY!
  return createClient(url, key, {
    global: { fetch: (u, options = {}) => fetch(u, { ...options, cache: 'no-store' }) },
  })
}

export async function LeaderboardContent({ calendar }: Props) {
  const supabase = getSupabase()

  // Check visibility
  const { data: settings } = await supabase
    .from('engagement_calendar_settings')
    .select('leaderboard_enabled, leaderboard_visibility, display_name_mode')
    .eq('calendar_id', calendar.id)
    .maybeSingle()

  if (settings?.leaderboard_enabled === false || settings?.leaderboard_visibility === 'admin-only') {
    return (
      <div className="text-center py-16">
        <h2 className="text-white text-2xl font-bold">Leaderboard not available</h2>
        <p className="text-white/60 mt-2">This calendar has disabled its public leaderboard.</p>
      </div>
    )
  }

  const { data: rows } = await supabase
    .from('engagement_scores_calendar')
    .select('person_id, total_points, event_count, last_active_at')
    .eq('calendar_id', calendar.id)
    .order('total_points', { ascending: false })
    .limit(100)

  if (!rows || rows.length === 0) {
    return (
      <div className="text-center py-16">
        <h2 className="text-white text-2xl font-bold">No engagement yet</h2>
        <p className="text-white/60 mt-2">Once members attend events, the leaderboard will fill in.</p>
      </div>
    )
  }

  // Resolve display names
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

  function resolveName(personId: string): string {
    const p = peopleById.get(personId)
    const prof = profilesById.get(personId)
    const attrs = p?.attributes || {}
    const firstName = attrs.first_name || 'Member'
    const lastName = attrs.last_name || ''
    switch (mode) {
      case 'full_name':
        return `${firstName} ${lastName}`.trim()
      case 'username':
        return prof?.username ? `@${prof.username}` : `${firstName} ${lastName ? lastName[0] + '.' : ''}`.trim()
      case 'anonymous':
        return `Member ${personId.slice(0, 4)}`
      case 'first_name_initial':
      default:
        return `${firstName} ${lastName ? lastName[0] + '.' : ''}`.trim()
    }
  }

  return (
    <div>
      <h2 className="text-white text-2xl font-bold mb-6">Leaderboard</h2>
      <div className="space-y-2">
        {rows.map((row: any, idx: number) => (
          <div
            key={row.person_id}
            className={`flex items-center justify-between px-4 py-3 rounded-lg border ${
              idx < 3
                ? 'bg-gradient-to-r from-yellow-500/10 to-transparent border-yellow-500/30'
                : 'bg-white/5 border-white/10'
            }`}
          >
            <div className="flex items-center gap-4 min-w-0">
              <div
                className={`size-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${
                  idx === 0
                    ? 'bg-yellow-400 text-black'
                    : idx === 1
                      ? 'bg-gray-300 text-black'
                      : idx === 2
                        ? 'bg-amber-700 text-white'
                        : 'bg-white/10 text-white/70'
                }`}
              >
                {idx + 1}
              </div>
              <div className="min-w-0">
                <div className="text-white font-medium truncate">{resolveName(row.person_id)}</div>
                <div className="text-white/40 text-xs">
                  {row.event_count} {row.event_count === 1 ? 'event' : 'events'}
                </div>
              </div>
            </div>
            <div className="text-white font-bold flex-shrink-0">
              {row.total_points.toLocaleString()}
              <span className="text-white/50 text-xs font-normal ml-1">pts</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
