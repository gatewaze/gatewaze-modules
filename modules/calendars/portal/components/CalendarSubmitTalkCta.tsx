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
    <section className="cal-talk-cta">
      <style>{`
        .cal-talk-card { display: flex; flex-direction: column; gap: 20px; overflow: hidden; padding: 24px;
          border-radius: 18px; background: var(--paper); border: 1px solid var(--line); }
        @media (min-width: 640px) { .cal-talk-card { flex-direction: row; align-items: center; padding: 28px; } }
        .cal-talk-h { font: 600 20px var(--font-display); color: var(--ink); margin: 0 0 8px; }
        .cal-talk-p { color: var(--ink-3); font-size: 14px; line-height: 1.55; max-width: 36rem; margin: 0; }
        .cal-talk-strong { color: var(--ink); font-weight: 500; }
      `}</style>
      <div className="cal-talk-card">
        <div style={{ flex: 1 }}>
          <h3 className="cal-talk-h">Got a talk to share?</h3>
          <p className="cal-talk-p">
            Pitch a talk to {calendar.name}. Organisers review submissions and reach out
            when they can put on an event that fits — you don't need a confirmed date.
            {typeof pendingCount === 'number' && pendingCount > 0 && (
              <>
                {' '}
                <span className="cal-talk-strong">
                  {pendingCount.toLocaleString()} {pendingCount === 1 ? 'talk' : 'talks'} already in the pool.
                </span>
              </>
            )}
          </p>
        </div>
        <Link href={`/calendars/${slug}/submit-talk`} className="btn btn-primary" style={{ whiteSpace: 'nowrap' }}>
          Submit a talk
        </Link>
      </div>
    </section>
  )
}
