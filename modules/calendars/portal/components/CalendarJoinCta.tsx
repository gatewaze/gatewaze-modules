// @ts-nocheck — portal deps are resolved at build time via webpack alias
import Link from 'next/link'
import type { Calendar } from '../lib/types'

interface Props {
  calendar: Calendar
}

export function CalendarJoinCta({ calendar }: Props) {
  const slug = calendar.slug || calendar.calendar_id

  return (
    <div
      style={{
        textAlign: 'center',
        overflow: 'hidden',
        padding: '56px 24px',
        borderRadius: 18,
        background: 'var(--paper)',
        border: '1px solid var(--line)',
      }}
    >
      <h2 style={{ font: '600 clamp(24px,3vw,30px) var(--font-display)', color: 'var(--ink)', letterSpacing: '-0.015em', margin: 0 }}>
        Join the {calendar.name} community
      </h2>
      <p style={{ color: 'var(--ink-3)', marginTop: 12, maxWidth: '36rem', marginLeft: 'auto', marginRight: 'auto', fontSize: 15, lineHeight: 1.55 }}>
        Get invited to upcoming events, hear about new talks, and stay in touch with what the chapter is doing.
      </p>
      <div style={{ marginTop: 24 }}>
        <Link href={`/calendars/${slug}/join`} className="btn btn-primary" style={{ height: 44, padding: '0 22px' }}>
          Join this calendar
        </Link>
      </div>
    </div>
  )
}
