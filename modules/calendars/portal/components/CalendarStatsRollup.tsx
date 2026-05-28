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
    <div className="mb-8">
      <h2 className="text-white/60 text-sm uppercase tracking-wider mb-4">By the numbers</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {visible.map((card) => (
          <div
            key={card.label}
            className="bg-white/5 border border-white/10 rounded-xl px-4 py-5"
          >
            <div className="text-3xl sm:text-4xl font-bold text-white">
              {card.value.toLocaleString()}
            </div>
            <div className="text-white/60 text-xs sm:text-sm mt-1">{card.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
