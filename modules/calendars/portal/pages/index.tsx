// @ts-nocheck — portal deps are resolved at build time via webpack alias
import Link from 'next/link'
import { getCalendars } from '../lib/calendars'
import type { Calendar } from '../lib/types'

export default async function CalendarsIndexPage() {
  const calendars = await getCalendars()

  return (
    <main className="relative z-10">
      <div className="max-w-7xl mx-auto px-6 sm:px-6 lg:px-8 py-8 sm:py-12">
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Calendars</h1>
          <p className="text-white/60 text-sm mt-1">Browse events grouped by community chapter</p>
        </div>

        {calendars.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {calendars.map((calendar) => (
              <CalendarCard key={calendar.id} calendar={calendar} />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}

function CalendarCard({ calendar }: { calendar: Calendar }) {
  const href = `/calendars/${calendar.slug || calendar.calendar_id}`

  return (
    <Link
      href={href}
      className="group block overflow-hidden bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-xl transition-colors"
    >
      {calendar.cover_image_url ? (
        <div
          className="aspect-[3/1] bg-cover bg-center"
          style={{ backgroundImage: `url(${calendar.cover_image_url})` }}
        />
      ) : (
        <div
          className="aspect-[3/1]"
          style={{
            background: calendar.color
              ? `linear-gradient(135deg, ${calendar.color}55, ${calendar.color}22)`
              : 'linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))',
          }}
        />
      )}
      <div className="p-4 flex items-center gap-3">
        {calendar.logo_url && (
          <img
            src={calendar.logo_url}
            alt={calendar.name}
            className="w-10 h-10 rounded-lg object-cover flex-shrink-0"
          />
        )}
        <div className="min-w-0">
          <h2 className="text-white font-semibold truncate">{calendar.name}</h2>
          {calendar.description && (
            <p className="text-white/60 text-sm line-clamp-2 mt-0.5">{calendar.description}</p>
          )}
        </div>
      </div>
    </Link>
  )
}

function EmptyState() {
  return (
    <div className="text-center py-16">
      <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-white/10 flex items-center justify-center">
        <svg className="w-8 h-8 text-white/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
      </div>
      <h2 className="text-white/60 text-2xl font-semibold">No calendars yet</h2>
      <p className="text-white/40 text-base mt-1">Check back soon</p>
    </div>
  )
}
