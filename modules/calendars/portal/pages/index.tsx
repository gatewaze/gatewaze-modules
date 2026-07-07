// @ts-nocheck — portal deps are resolved at build time via webpack alias
import Link from 'next/link'
import { getCalendars } from '../lib/calendars'
import type { Calendar } from '../lib/types'

export default async function CalendarsIndexPage() {
  const calendars = await getCalendars()

  return (
    <div className="pub-wrap">
      <div className="pub-h">
        <h1>Calendars</h1>
        <p>Browse events grouped by community chapter.</p>
      </div>

      {calendars.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="pub-grid">
          {calendars.map((calendar) => (
            <CalendarCard key={calendar.id} calendar={calendar} />
          ))}
        </div>
      )}
    </div>
  )
}

function CalendarCard({ calendar }: { calendar: Calendar }) {
  const href = `/calendars/${calendar.slug || calendar.calendar_id}`

  return (
    <Link href={href} className="pub-card gw-card-glow">
      <div className="pub-cover">
        {calendar.cover_image_url ? (
          <img src={calendar.cover_image_url} alt={calendar.name} />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              background: calendar.color
                ? `linear-gradient(135deg, ${calendar.color}55, ${calendar.color}22)`
                : undefined,
            }}
          />
        )}
      </div>
      <div className="pub-card-body" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {calendar.logo_url && (
          <img
            src={calendar.logo_url}
            alt={calendar.name}
            style={{ width: 40, height: 40, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }}
          />
        )}
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{calendar.name}</h3>
          {calendar.description && (
            <p style={{ marginTop: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{calendar.description}</p>
          )}
        </div>
      </div>
    </Link>
  )
}

function EmptyState() {
  return (
    <div className="pub-empty">
      <h2 style={{ font: '600 20px var(--font-display)', color: 'var(--ink-3)', margin: 0 }}>No calendars yet</h2>
      <p style={{ color: 'var(--ink-4)', marginTop: 4 }}>Check back soon.</p>
    </div>
  )
}
