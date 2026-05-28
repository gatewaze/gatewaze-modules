// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { notFound } from 'next/navigation'
import {
  getCalendarWithEvents,
  getCalendarRollupStats,
  getCalendarMediaHighlights,
  getCalendarSubNavVisibility,
} from '../../lib/calendars'
import { CalendarHero } from '../../components/CalendarHero'
import { CalendarHeader } from '../../components/CalendarHeader'
import { CalendarUpcomingStrip } from '../../components/CalendarUpcomingStrip'
import { CalendarStatsRollup } from '../../components/CalendarStatsRollup'
import { CalendarMediaGallery } from '../../components/CalendarMediaGallery'
import { CalendarPastHighlights } from '../../components/CalendarPastHighlights'
import { CalendarJoinCta } from '../../components/CalendarJoinCta'
import { CalendarSubmitTalkCta } from '../../components/CalendarSubmitTalkCta'
import { getCalendarPendingTalkCount, getViewerPersonId } from '../../lib/calendars'
import { getServerBrandConfig } from '@/config/brand'

interface Props {
  params: { slug: string }
}

export default async function CalendarLandingPage({ params }: Props) {
  const slug = params.slug
  const result = await getCalendarWithEvents(slug)
  if (!result) notFound()

  const { calendar, upcoming, past } = result

  const viewerPersonId = await getViewerPersonId()

  // Fetch stats, media, visibility, pending talk count + brand config in parallel
  const [stats, media, visibility, pendingTalkCount, brandConfig] = await Promise.all([
    getCalendarRollupStats(calendar.id),
    getCalendarMediaHighlights(calendar.id, { limit: 8 }),
    getCalendarSubNavVisibility(calendar.id, viewerPersonId),
    getCalendarPendingTalkCount(calendar.id),
    getServerBrandConfig(),
  ])

  const canonicalSlug = calendar.slug || calendar.calendar_id

  return (
    <main className="relative z-10">
      <div className="max-w-7xl mx-auto px-6 sm:px-6 lg:px-8 py-8 sm:py-12">
        <CalendarHero
          calendar={calendar}
          memberCount={stats.totalMembers}
          storageBucketUrl={brandConfig.storageBucketUrl}
        />

        <CalendarHeader
          calendar={calendar}
          visibility={visibility}
          active=""
          primaryColor={brandConfig.primaryColor}
        />

        <CalendarUpcomingStrip events={upcoming} calendarSlug={canonicalSlug} />

        <CalendarStatsRollup stats={stats} />

        <CalendarMediaGallery items={media} calendarSlug={canonicalSlug} />

        <CalendarPastHighlights events={past} calendarSlug={canonicalSlug} />

        <div className="space-y-10 mt-12">
          {visibility.submitTalk && (
            <CalendarSubmitTalkCta calendar={calendar} pendingCount={pendingTalkCount} />
          )}

          <CalendarJoinCta calendar={calendar} />
        </div>
      </div>
    </main>
  )
}
