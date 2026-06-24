// @ts-nocheck — portal deps are resolved at build time via webpack alias
//
// Calendar microsite Events tab. Renders the calendar's full event list as a
// rich timeline with Upcoming / Past / Calendar-grid view modes. The
// rendering lives in <CalendarEventTimeline> — this page is just the data
// fetch + chrome.

import { notFound } from 'next/navigation'
import {
  getCalendarWithEvents,
  getCalendarEventTimeline,
  getCalendarSubNavVisibility,
  getViewerPersonId,
} from '../../lib/calendars'
import { CalendarHero } from '../../components/CalendarHero'
import { CalendarHeader } from '../../components/CalendarHeader'
import { CalendarEventTimeline } from '../../components/CalendarEventTimeline'
import { getServerBrandConfig } from '@/config/brand'

interface Props {
  params: { slug: string }
}

export default async function CalendarEventsPage({ params }: Props) {
  const slug = params.slug
  const result = await getCalendarWithEvents(slug)
  if (!result) notFound()

  const { calendar } = result
  const viewerPersonId = await getViewerPersonId()

  const [timeline, visibility, brandConfig] = await Promise.all([
    getCalendarEventTimeline(calendar.id),
    getCalendarSubNavVisibility(calendar.id, viewerPersonId),
    getServerBrandConfig(),
  ])

  const canonicalSlug = calendar.slug || calendar.calendar_id

  return (
    <div className="pub-wrap">
      <CalendarHero calendar={calendar} storageBucketUrl={brandConfig.storageBucketUrl} />
      <CalendarHeader
        calendar={calendar}
        visibility={visibility}
        active="events"
        primaryColor={brandConfig.primaryColor}
      />

      <CalendarEventTimeline
        calendar={calendar}
        upcoming={timeline.upcoming}
        past={timeline.past}
        feedPath={`/api/calendars/${canonicalSlug}/feed.ics`}
        primaryColor={brandConfig.primaryColor}
      />
    </div>
  )
}
