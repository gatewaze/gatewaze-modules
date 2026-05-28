// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { notFound } from 'next/navigation'
import {
  getCalendarWithEvents,
  getCalendarRollupStats,
  getCalendarSubNavVisibility,
  getViewerPersonId,
} from '../../lib/calendars'
import { CalendarHero } from '../../components/CalendarHero'
import { CalendarHeader } from '../../components/CalendarHeader'
import { CalendarJoinForm } from '../../components/CalendarJoinForm'
import { getServerBrandConfig } from '@/config/brand'

interface Props {
  params: { slug: string }
}

const MAX_TOPIC_CHIPS = 12

export default async function CalendarJoinPage({ params }: Props) {
  const slug = params.slug
  const result = await getCalendarWithEvents(slug)
  if (!result) notFound()

  const { calendar, upcoming } = result
  const viewerPersonId = await getViewerPersonId()
  const [stats, visibility, brandConfig] = await Promise.all([
    getCalendarRollupStats(calendar.id),
    getCalendarSubNavVisibility(calendar.id, viewerPersonId),
    getServerBrandConfig(),
  ])

  // Aggregate topics across upcoming events for the chip selector.
  // Lower-cased + counted so the most-used topics surface first.
  const topicCounts = new Map<string, number>()
  for (const ev of upcoming) {
    for (const raw of ev.event_topics ?? []) {
      const t = (raw || '').trim().toLowerCase()
      if (!t) continue
      topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1)
    }
  }
  const topicChips = Array.from(topicCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOPIC_CHIPS)
    .map(([t]) => t)

  // First three upcoming events for the post-join landing preview.
  const nextEvents = upcoming.slice(0, 3).map((ev) => ({
    event_id: ev.event_id,
    event_slug: ev.event_slug,
    event_title: ev.event_title,
    event_start: ev.event_start,
    event_city: ev.event_city,
    event_country_code: ev.event_country_code,
    event_logo: ev.event_logo,
    screenshot_url: ev.screenshot_url,
    gradient_color_1: ev.gradient_color_1,
    gradient_color_2: ev.gradient_color_2,
  }))

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
          active="join"
          primaryColor={brandConfig.primaryColor}
        />

        <div>
          <h2 className="text-white text-3xl font-bold mb-3">Join</h2>
          <p className="text-white/70 mb-8 max-w-2xl">
            Become a member to get notified about upcoming events and stay in touch with the chapter.
          </p>

          <CalendarJoinForm
            calendar={calendar}
            memberCount={stats.totalMembers}
            topicChips={topicChips}
            nextEvents={nextEvents}
            primaryColor={brandConfig.primaryColor}
          />

          <div
            className="mt-8 p-6"
            style={{
              borderRadius: 'var(--radius-control, 12px)',
              backgroundColor: `rgba(var(--panel-tint, 0,0,0), var(--glass-opacity, 0.05))`,
              backdropFilter: `blur(var(--glass-blur, 4px))`,
              WebkitBackdropFilter: `blur(var(--glass-blur, 4px))`,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: `rgba(var(--panel-tint, 0,0,0), var(--glass-border-opacity, 0.1))`,
            }}
          >
            <h3 className="text-white font-semibold mb-3">How this works</h3>
            <ul className="space-y-2 text-white/70 text-sm">
              <li className="flex gap-3">
                <span className="text-white/40">1.</span>
                <span>Submit the form with your name and email.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-white/40">2.</span>
                <span>We send you a confirmation email — click the link to confirm.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-white/40">3.</span>
                <span>You'll get notified about upcoming events from {calendar.name}.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-white/40">4.</span>
                <span>Unsubscribe any time — every email has a one-click unsubscribe link.</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </main>
  )
}
