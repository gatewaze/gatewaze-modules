// @ts-nocheck — portal deps are resolved at build time via webpack alias
import Link from 'next/link'
import type { CalendarMediaItem } from '../lib/types'

interface Props {
  items: CalendarMediaItem[]
  showTitle?: boolean
  calendarSlug?: string
}

export function CalendarMediaGallery({ items, showTitle = true, calendarSlug }: Props) {
  if (items.length === 0) return null

  return (
    <div className="mb-8">
      {showTitle && (
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white text-xl font-semibold">Media highlights</h2>
          {calendarSlug && (
            <Link
              href={`/calendars/${calendarSlug}/media`}
              className="text-white/60 hover:text-white text-sm"
            >
              See all →
            </Link>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {items.map((item) => (
          <div
            key={item.id}
            className="relative aspect-square bg-white/5 rounded-lg overflow-hidden group"
          >
            <img
              src={item.thumbnail_url || item.url}
              alt={item.caption || item.event_title}
              className="absolute inset-0 w-full h-full object-cover"
              loading="lazy"
            />
            {item.type === 'video' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
                <div className="w-12 h-12 bg-white/90 rounded-full flex items-center justify-center">
                  <svg className="w-6 h-6 text-black ml-1" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <div className="text-white/90 text-xs truncate">{item.event_title}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
