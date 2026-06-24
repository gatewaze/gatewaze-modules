// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { notFound } from 'next/navigation'
import {
  getCalendarWithEvents,
  getCalendarMediaHighlights,
  getCalendarSubNavVisibility,
  getViewerPersonId,
} from '../../lib/calendars'
import { CalendarHeader } from '../../components/CalendarHeader'
import { CalendarMediaGallery } from '../../components/CalendarMediaGallery'

interface Props {
  params: { slug: string }
  searchParams?: { type?: string }
}

export default async function CalendarMediaPage({ params, searchParams }: Props) {
  const slug = params.slug
  const result = await getCalendarWithEvents(slug)
  if (!result) notFound()

  const { calendar } = result
  const viewerPersonId = await getViewerPersonId()
  const visibility = await getCalendarSubNavVisibility(calendar.id, viewerPersonId)
  const filterType = (searchParams?.type as 'photo' | 'video' | 'all') || 'all'

  const items = await getCalendarMediaHighlights(calendar.id, {
    limit: 100,
    type: filterType,
  })

  const canonicalSlug = calendar.slug || calendar.calendar_id
  const filterPills: Array<{ key: 'all' | 'photo' | 'video'; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'photo', label: 'Photos' },
    { key: 'video', label: 'Videos' },
  ]

  return (
    <div className="pub-wrap">
      <style>{`
        .cal-media-filter { padding: 6px 16px; font-size: 14px; border-radius: 999px; text-decoration: none; transition: background .15s ease, color .15s ease;
          background: rgba(var(--ui-text), 0.05); color: var(--ink-3); border: 1px solid var(--line); }
        .cal-media-filter:hover { background: rgba(var(--ui-text), 0.1); color: var(--ink); }
        .cal-media-filter.on { background: var(--ink); color: var(--paper); font-weight: 600; border-color: var(--ink); }
      `}</style>
      <CalendarHeader calendar={calendar} visibility={visibility} active="media" />

      <div style={{ marginBottom: 24, display: 'flex', gap: 8 }}>
        {filterPills.map((pill) => (
          <a
            key={pill.key}
            href={`/calendars/${canonicalSlug}/media${pill.key === 'all' ? '' : `?type=${pill.key}`}`}
            className={`cal-media-filter${filterType === pill.key ? ' on' : ''}`}
          >
            {pill.label}
          </a>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="pub-empty" style={{ marginTop: 0 }}>
          <h2 style={{ font: '600 20px var(--font-display)', color: 'var(--ink-3)', margin: 0 }}>No media yet</h2>
          <p style={{ color: 'var(--ink-4)', marginTop: 4 }}>Photos and videos from past events will appear here.</p>
        </div>
      ) : (
        <CalendarMediaGallery items={items} showTitle={false} />
      )}
    </div>
  )
}
