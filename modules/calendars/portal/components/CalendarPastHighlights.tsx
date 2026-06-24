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
    <section className="cal-past" style={{ marginBottom: 32 }}>
      <style>{`
        .cal-past-row { display: flex; align-items: center; gap: 16px; text-decoration: none;
          background: var(--paper); border: 1px solid rgba(var(--ui-text), 0.10); border-radius: 12px; padding: 12px 16px;
          transition: border-color .2s ease, transform .2s ease; }
        .cal-past-row:hover { border-color: rgba(var(--ui-text), 0.28); transform: translateY(-2px); }
        .cal-past-date { color: var(--ink-4); font-size: 12px; width: 80px; flex-shrink: 0; }
        .cal-past-title { color: var(--ink); font-weight: 500; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .cal-past-city { color: var(--ink-3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      `}</style>
      <div className="pub-sechead" style={{ marginBottom: 14 }}>
        <h2 style={{ font: '600 22px var(--font-display)', color: 'var(--ink)', letterSpacing: '-0.01em', margin: 0 }}>
          Looking back
        </h2>
        <Link href={`/calendars/${calendarSlug}/events`} className="pub-viewall">
          See all past events →
        </Link>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {events.slice(0, 6).map((event) => (
          <Link
            key={event.event_id}
            href={`/events/${event.event_slug || event.event_id}`}
            className="cal-past-row"
          >
            <div className="cal-past-date">{formatDate(event.event_start)}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="cal-past-title">{event.event_title}</div>
              {event.event_city && <div className="cal-past-city">{event.event_city}</div>}
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}
