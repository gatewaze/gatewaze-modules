// @ts-nocheck — portal deps are resolved at build time via webpack alias
import type { CalendarRollupStats } from '../lib/types'

interface Props {
  stats: CalendarRollupStats
}

interface StatCardData {
  label: string
  value: number
  show: boolean
}

export function CalendarStatsRollup({ stats }: Props) {
  const cards: StatCardData[] = [
    { label: 'Events hosted', value: stats.pastCount, show: stats.pastCount > 0 },
    { label: 'Attendees', value: stats.totalAttendees, show: stats.totalAttendees > 0 },
    { label: 'Speakers', value: stats.totalSpeakers, show: stats.totalSpeakers > 0 },
    { label: 'Photos & videos', value: stats.totalMediaItems, show: stats.totalMediaItems > 0 },
  ]
  const visible = cards.filter(c => c.show)
  if (visible.length === 0) return null

  return (
    <section className="cal-stats" style={{ marginBottom: 32 }}>
      <style>{`
        .cal-stats-head { font: 600 10.5px var(--font-mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-4); margin: 0 0 14px; }
        .cal-stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
        @media (min-width: 640px) { .cal-stats-grid { grid-template-columns: repeat(4, 1fr); } }
        .cal-stat-card { background: var(--paper); border: 1px solid rgba(var(--ui-text), 0.10); border-radius: 16px; padding: 18px 16px; }
        .cal-stat-val { font: 600 clamp(28px,4vw,36px) var(--font-display); color: var(--ink); line-height: 1.1; }
        .cal-stat-lbl { color: var(--ink-3); font-size: 13px; margin-top: 4px; }
      `}</style>
      <h2 className="cal-stats-head">By the numbers</h2>
      <div className="cal-stats-grid">
        {visible.map((card) => (
          <div key={card.label} className="cal-stat-card">
            <div className="cal-stat-val">{card.value.toLocaleString()}</div>
            <div className="cal-stat-lbl">{card.label}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
