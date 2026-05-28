// @ts-nocheck — portal deps are resolved at build time via webpack alias
import Link from 'next/link'
import type { CalendarEvent } from '../lib/types'

interface Props {
  events: CalendarEvent[]
  calendarSlug: string
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

export function CalendarPastHighlights({ events, calendarSlug }: Props) {
  if (events.length === 0) return null

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-white text-xl font-semibold">Looking back</h2>
        <Link
          href={`/calendars/${calendarSlug}/events`}
          className="text-white/60 hover:text-white text-sm"
        >
          See all past events →
        </Link>
      </div>
      <div className="space-y-2">
        {events.slice(0, 6).map((event) => (
          <Link
            key={event.event_id}
            href={`/events/${event.event_slug || event.event_id}`}
            className="flex items-center gap-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-4 py-3 transition-colors"
          >
            <div className="text-white/40 text-xs w-20 flex-shrink-0">
              {formatDate(event.event_start)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-white font-medium truncate">{event.event_title}</div>
              {event.event_city && (
                <div className="text-white/50 text-xs truncate">{event.event_city}</div>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
