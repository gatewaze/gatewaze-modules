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
      className="px-6 sm:px-10 py-10 sm:py-14 text-center overflow-hidden"
      style={{
        borderRadius: 'var(--radius-control, 12px)',
        backgroundColor: `rgba(var(--panel-tint, 0,0,0), var(--glass-opacity, 0.05))`,
        backdropFilter: `blur(var(--glass-blur, 4px))`,
        WebkitBackdropFilter: `blur(var(--glass-blur, 4px))`,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: `rgba(var(--panel-tint, 0,0,0), var(--glass-border-opacity, 0.1))`,
      }}
    >
      <h2 className="text-white text-2xl sm:text-3xl font-bold">
        Join the {calendar.name} community
      </h2>
      <p className="text-white/70 mt-3 max-w-xl mx-auto">
        Get invited to upcoming events, hear about new talks, and stay in touch with what the chapter is doing.
      </p>
      <div className="mt-6">
        <Link
          href={`/calendars/${slug}/join`}
          className="inline-flex items-center gap-2 px-6 py-3 bg-black text-white font-semibold rounded-lg hover:bg-black/80 transition-colors"
        >
          Join this calendar
        </Link>
      </div>
    </div>
  )
}
