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
    <main className="relative z-10">
      <div className="max-w-7xl mx-auto px-6 sm:px-6 lg:px-8 py-8 sm:py-12">
        <CalendarHeader calendar={calendar} visibility={visibility} active="media" />

        <div className="mb-6 flex gap-2">
          {filterPills.map((pill) => (
            <a
              key={pill.key}
              href={`/calendars/${canonicalSlug}/media${pill.key === 'all' ? '' : `?type=${pill.key}`}`}
              className={`px-4 py-2 text-sm rounded-full transition-colors ${
                filterType === pill.key
                  ? 'bg-white text-black font-semibold'
                  : 'bg-white/5 text-white/70 hover:bg-white/10 hover:text-white border border-white/10'
              }`}
            >
              {pill.label}
            </a>
          ))}
        </div>

        {items.length === 0 ? (
          <div className="text-center py-16">
            <h2 className="text-white/60 text-2xl font-semibold">No media yet</h2>
            <p className="text-white/40 text-base mt-1">Photos and videos from past events will appear here.</p>
          </div>
        ) : (
          <CalendarMediaGallery items={items} showTitle={false} />
        )}
      </div>
    </main>
  )
}
