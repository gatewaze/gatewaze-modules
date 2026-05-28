// @ts-nocheck — portal deps are resolved at build time via webpack alias
import Link from 'next/link'
import type { CalendarEvent } from '../lib/types'

interface Props {
  events: CalendarEvent[]
  calendarSlug: string
}

function formatDate(iso: string | null): string {
  if (!iso) return 'TBA'
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function CalendarUpcomingStrip({ events, calendarSlug }: Props) {
  if (events.length === 0) return null

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-white text-xl font-semibold">Upcoming events</h2>
        <Link
          href={`/calendars/${calendarSlug}/events`}
          className="text-white/60 hover:text-white text-sm"
        >
          See all →
        </Link>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {events.slice(0, 6).map((event) => (
          <Link
            key={event.event_id}
            href={`/events/${event.event_slug || event.event_id}`}
            className="group block bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-xl overflow-hidden transition-colors"
          >
            {(event.event_logo || event.screenshot_url) ? (
              <div
                className="aspect-[16/9] bg-cover bg-center"
                style={{ backgroundImage: `url(${event.event_logo || event.screenshot_url})` }}
              />
            ) : (
              <div
                className="aspect-[16/9]"
                style={{
                  background: event.gradient_color_1
                    ? `linear-gradient(135deg, ${event.gradient_color_1}, ${event.gradient_color_2 || event.gradient_color_1})`
                    : 'linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))',
                }}
              />
            )}
            <div className="p-4">
              <div className="text-white/60 text-xs">{formatDate(event.event_start)}</div>
              <h3 className="text-white font-semibold mt-1 line-clamp-2 group-hover:text-white">
                {event.event_title}
              </h3>
              {event.event_city && (
                <p className="text-white/50 text-xs mt-1">{event.event_city}</p>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
