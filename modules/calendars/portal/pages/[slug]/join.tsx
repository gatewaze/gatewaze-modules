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
    <div className="pub-wrap">
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
        <h2 style={{ font: '600 30px var(--font-display)', color: 'var(--ink)', letterSpacing: '-0.02em', margin: '0 0 12px' }}>Join</h2>
        <p style={{ color: 'var(--ink-3)', margin: '0 0 32px', maxWidth: '42rem', fontSize: 15, lineHeight: 1.6 }}>
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
          style={{
            marginTop: 32,
            padding: 24,
            borderRadius: 18,
            background: 'var(--paper)',
            border: '1px solid var(--line)',
          }}
        >
          <h3 style={{ font: '600 16px var(--font-display)', color: 'var(--ink)', margin: '0 0 12px' }}>How this works</h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8, color: 'var(--ink-3)', fontSize: 14 }}>
            <li style={{ display: 'flex', gap: 12 }}>
              <span style={{ color: 'var(--ink-4)' }}>1.</span>
              <span>Submit the form with your name and email.</span>
            </li>
            <li style={{ display: 'flex', gap: 12 }}>
              <span style={{ color: 'var(--ink-4)' }}>2.</span>
              <span>We send you a confirmation email — click the link to confirm.</span>
            </li>
            <li style={{ display: 'flex', gap: 12 }}>
              <span style={{ color: 'var(--ink-4)' }}>3.</span>
              <span>You'll get notified about upcoming events from {calendar.name}.</span>
            </li>
            <li style={{ display: 'flex', gap: 12 }}>
              <span style={{ color: 'var(--ink-4)' }}>4.</span>
              <span>Unsubscribe any time — every email has a one-click unsubscribe link.</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}
