// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { notFound } from 'next/navigation'
import { getCalendarWithEvents, getCalendarSubNavVisibility, getViewerPersonId } from '../../lib/calendars'
import { CalendarHeader } from '../../components/CalendarHeader'

interface Props {
  params: { slug: string }
}

/**
 * Calendar microsite leaderboard sub-page.
 *
 * Route lives in the calendars module (so the URL is /calendars/[slug]/leaderboard)
 * but the rendering logic lives in the engagement module. If engagement isn't
 * installed the page falls back to a friendly "not available" message.
 */
export default async function CalendarLeaderboardPage({ params }: Props) {
  const slug = params.slug
  const result = await getCalendarWithEvents(slug)
  if (!result) notFound()

  const { calendar } = result
  const viewerPersonId = await getViewerPersonId()
  const visibility = await getCalendarSubNavVisibility(calendar.id, viewerPersonId)

  let LeaderboardContent: any = null
  try {
    const mod = await import(
      /* @vite-ignore */ '../../../../engagement/portal/calendar-pages/leaderboard'
    )
    LeaderboardContent = mod.LeaderboardContent
  } catch {
    // engagement module not installed
  }

  return (
    <div className="pub-wrap">
      <CalendarHeader calendar={calendar} visibility={visibility} active="" />

      {LeaderboardContent ? (
        <LeaderboardContent calendar={calendar} />
      ) : (
        <div className="pub-empty" style={{ marginTop: 0 }}>
          <h2 style={{ font: '600 20px var(--font-display)', color: 'var(--ink)', margin: 0 }}>Leaderboard not available</h2>
          <p style={{ color: 'var(--ink-3)', marginTop: 8 }}>
            The engagement module is not installed on this brand.
          </p>
        </div>
      )}
    </div>
  )
}
