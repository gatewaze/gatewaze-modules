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
    <section className="pub-sec" style={{ marginTop: 0, marginBottom: 32 }}>
      <div className="pub-sechead" style={{ marginBottom: 6 }}>
        <h2 style={{ font: '600 22px var(--font-display)', color: 'var(--ink)', letterSpacing: '-0.01em', margin: 0 }}>
          Upcoming events
        </h2>
        <Link href={`/calendars/${calendarSlug}/events`} className="pub-viewall">
          See all →
        </Link>
      </div>
      <div className="pub-grid">
        {events.slice(0, 6).map((event) => (
          <Link
            key={event.event_id}
            href={`/events/${event.event_slug || event.event_id}`}
            className="pub-card"
          >
            <div className="pub-cover">
              {(event.event_logo || event.screenshot_url) ? (
                <img src={event.event_logo || event.screenshot_url} alt={event.event_title} />
              ) : (
                <div
                  style={{
                    width: '100%',
                    height: '100%',
                    background: event.gradient_color_1
                      ? `linear-gradient(135deg, ${event.gradient_color_1}, ${event.gradient_color_2 || event.gradient_color_1})`
                      : undefined,
                  }}
                />
              )}
            </div>
            <div className="pub-card-body">
              <div className="pub-meta" style={{ marginTop: 0 }}>{formatDate(event.event_start)}</div>
              <h3>{event.event_title}</h3>
              {event.event_city && <p>{event.event_city}</p>}
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}
