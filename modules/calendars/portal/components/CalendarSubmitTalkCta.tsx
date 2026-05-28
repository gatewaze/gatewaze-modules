// @ts-nocheck — portal deps are resolved at build time via webpack alias
import Link from 'next/link'
import type { Calendar } from '../lib/types'

interface Props {
  calendar: Calendar
  /**
   * Number of pending talks already in the calendar's talk pool.
   * When > 0 we surface it as social proof ("N talks waiting for a slot").
   */
  pendingCount?: number
}

export function CalendarSubmitTalkCta({ calendar, pendingCount }: Props) {
  const slug = calendar.slug || calendar.calendar_id
  return (
    <section>
      <div
        className="overflow-hidden p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center gap-6"
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
        <div className="flex-1">
          <h3 className="text-white text-xl font-semibold mb-2">
            Got a talk to share?
          </h3>
          <p className="text-white/70 text-sm max-w-xl">
            Pitch a talk to {calendar.name}. Organisers review submissions and reach out
            when they can put on an event that fits — you don't need a confirmed date.
            {typeof pendingCount === 'number' && pendingCount > 0 && (
              <>
                {' '}
                <span className="text-white/90 font-medium">
                  {pendingCount.toLocaleString()} {pendingCount === 1 ? 'talk' : 'talks'} already in the pool.
                </span>
              </>
            )}
          </p>
        </div>
        <Link
          href={`/calendars/${slug}/submit-talk`}
          className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-black text-white text-sm font-semibold hover:bg-black/80 whitespace-nowrap"
        >
          Submit a talk
        </Link>
      </div>
    </section>
  )
}
