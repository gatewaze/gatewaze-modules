// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import type { Calendar, CalendarTimelineEvent } from '../lib/types'
import { CalendarMonthGrid } from './CalendarMonthGrid'
import { isLightColor } from '@/config/brand'

interface Props {
  calendar: Calendar
  upcoming: CalendarTimelineEvent[]
  past: CalendarTimelineEvent[]
  /**
   * Path to the calendar's ICS feed — surfaced in empty states so visitors
   * can subscribe even before there's anything scheduled.
   */
  feedPath?: string
  /** Brand primary colour used for the active tab fill. */
  primaryColor?: string
}

type ViewMode = 'upcoming' | 'past' | 'grid'

const TAB_LABELS: { value: ViewMode; label: string }[] = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'past',     label: 'Past'     },
  { value: 'grid',     label: 'Calendar' },
]

export function CalendarEventTimeline({ calendar, upcoming, past, feedPath, primaryColor = '#ffffff' }: Props) {
  const [view, setView] = useState<ViewMode>(upcoming.length > 0 ? 'upcoming' : past.length > 0 ? 'past' : 'upcoming')

  const slug = calendar.slug || calendar.calendar_id
  const accent = calendar.color || '#ffffff'
  const lightPrimary = isLightColor(primaryColor)

  // For the Calendar grid, feed it *all* known events so the user can navigate
  // back into the past or forward into the future from the same view.
  const allEvents = useMemo<CalendarTimelineEvent[]>(() => {
    const merged = [...upcoming, ...past]
    merged.sort((a, b) => (a.event_start || '').localeCompare(b.event_start || ''))
    return merged
  }, [upcoming, past])

  return (
    <div>
      <div
        className="flex w-full sm:inline-flex sm:w-auto p-1 gap-1 mb-6"
        style={{
          borderRadius: 'var(--radius-control-outer)',
          backgroundColor: `rgba(var(--panel-tint,0,0,0),var(--glass-opacity,0.05))`,
          backdropFilter: `blur(var(--glass-blur,4px))`,
          WebkitBackdropFilter: `blur(var(--glass-blur,4px))`,
          border: `1px solid rgba(var(--panel-tint,0,0,0),var(--glass-border-opacity,0.1))`,
        }}
      >
        {TAB_LABELS.map((t) => {
          const active = t.value === view
          const count = t.value === 'upcoming' ? upcoming.length : t.value === 'past' ? past.length : null
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setView(t.value)}
              className={`
                cursor-pointer flex items-center justify-center gap-1 flex-1 sm:flex-initial px-4 py-2 text-base font-medium transition-all duration-200 ease-out
                ${active ? 'shadow-lg' : 'text-white/70 hover:text-white hover:bg-white/10'}
              `}
              style={{
                borderRadius: 'var(--radius-control)',
                ...(active ? { backgroundColor: primaryColor, color: lightPrimary ? '#000000' : '#ffffff' } : {}),
              }}
            >
              <span>{t.label}</span>
              {typeof count === 'number' && count > 0 && (
                <span
                  className={`ml-1.5 px-1.5 py-0.5 rounded-full text-xs font-medium transition-colors duration-200
                    ${active ? (lightPrimary ? 'bg-black/10' : 'bg-white/20') : 'bg-white/10'}`}
                >
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {view === 'upcoming' && (
        <UpcomingTimeline
          events={upcoming}
          slug={slug}
          accent={accent}
          calendarName={calendar.name}
          feedPath={feedPath}
        />
      )}

      {view === 'past' && (
        <PastTimeline events={past} slug={slug} accent={accent} calendarName={calendar.name} />
      )}

      {view === 'grid' && (
        <CalendarMonthGrid events={allEvents} brandColor={calendar.color} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Upcoming view: hero card for the very next event, then month-grouped cards.
// ---------------------------------------------------------------------------

function UpcomingTimeline({
  events,
  slug,
  accent,
  calendarName,
  feedPath,
}: {
  events: CalendarTimelineEvent[]
  slug: string
  accent: string
  calendarName: string
  feedPath?: string
}) {
  if (events.length === 0) {
    return (
      <EmptyState
        title="No upcoming events yet"
        body={`The ${calendarName} organisers haven't scheduled the next one yet. Join the calendar to get notified when they do.`}
        primary={{ href: `/calendars/${slug}/join`, label: 'Join the calendar' }}
      />
    )
  }

  const [hero, ...rest] = events
  const restByMonth = groupByMonth(rest)

  return (
    <div className="space-y-12">
      <HeroEventCard event={hero} slug={slug} accent={accent} />

      {restByMonth.length > 0 && (
        <MonthGroupedTimeline groups={restByMonth} accent={accent} mode="upcoming" />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Past view: month-grouped, denser cards (no hero), past-tone palette.
// ---------------------------------------------------------------------------

function PastTimeline({
  events,
  slug,
  accent,
  calendarName,
}: {
  events: CalendarTimelineEvent[]
  slug: string
  accent: string
  calendarName: string
}) {
  if (events.length === 0) {
    return (
      <EmptyState
        title="No past events to show"
        body={`${calendarName} is just getting started. Once the first event happens, it'll show up here.`}
        primary={{ href: `/calendars/${slug}/join`, label: 'Join the calendar' }}
      />
    )
  }
  const grouped = groupByMonth(events)
  return <MonthGroupedTimeline groups={grouped} accent={accent} mode="past" />
}

// ---------------------------------------------------------------------------
// Hero card — full-width, large cover, prominent CTA. Used for the next event.
// ---------------------------------------------------------------------------

function HeroEventCard({
  event,
  slug,
  accent,
}: {
  event: CalendarTimelineEvent
  slug: string
  accent: string
}) {
  const start = event.event_start ? new Date(event.event_start) : null
  return (
    <Link
      href={`/events/${event.event_slug || event.event_id}`}
      className="group block overflow-hidden transition-all duration-200 hover:brightness-110"
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
      <div className="grid grid-cols-1 md:grid-cols-2">
        <div
          className="relative aspect-[16/10] md:aspect-auto bg-cover bg-center"
          style={
            event.event_logo || event.screenshot_url
              ? { backgroundImage: `url(${event.event_logo || event.screenshot_url})` }
              : {
                  background: event.gradient_color_1
                    ? `linear-gradient(135deg, ${event.gradient_color_1}, ${event.gradient_color_2 || event.gradient_color_1})`
                    : `linear-gradient(135deg, ${accent}33, ${accent}11)`,
                }
          }
        >
          {event.is_featured && (
            <div className="absolute top-4 left-4 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-black/60 backdrop-blur text-white text-xs font-medium">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>
              Featured
            </div>
          )}
        </div>
        <div className="p-6 md:p-10 flex flex-col justify-center">
          {start && (
            <div className="flex items-center gap-3 mb-4">
              <div className="text-center">
                <div className="text-[11px] uppercase tracking-wider text-white/50">
                  {start.toLocaleDateString(undefined, { month: 'short' })}
                </div>
                <div className="text-3xl font-bold text-white leading-none">
                  {start.getDate()}
                </div>
              </div>
              <div className="text-sm text-white/60">
                <div>{start.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric' })}</div>
                <div>{start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}{event.event_timezone ? ` · ${event.event_timezone}` : ''}</div>
              </div>
            </div>
          )}
          <h3 className="text-white text-2xl md:text-3xl font-bold mb-3 group-hover:underline underline-offset-4 decoration-2">
            {event.event_title}
          </h3>
          {formatLocationLabel(event) && (
            <p className="text-white/70 text-sm mb-5">
              📍 {formatLocationLabel(event)}
            </p>
          )}

          <StatPills event={event} mode="upcoming" />

          <span className="mt-6 inline-flex w-fit items-center gap-2 px-4 py-2 rounded-lg bg-black text-white text-sm font-semibold">
            View event
            <span aria-hidden>→</span>
          </span>
        </div>
      </div>
    </Link>
  )
}

// ---------------------------------------------------------------------------
// Month-grouped timeline. Sticky month headers with a vertical spine on the
// left and event cards on the right.
// ---------------------------------------------------------------------------

interface MonthGroup {
  key: string       // 'YYYY-MM'
  label: string     // 'November 2026'
  events: CalendarTimelineEvent[]
}

function MonthGroupedTimeline({
  groups,
  accent,
  mode,
}: {
  groups: MonthGroup[]
  accent: string
  mode: 'upcoming' | 'past'
}) {
  return (
    <div>
      {groups.map((g, i) => (
        <section key={g.key} className={i === 0 ? '' : 'mt-12'}>
          <div className="mb-5 pb-3 border-b border-white/10">
            <h3 className="text-white text-lg font-semibold flex items-center gap-3">
              {g.label}
              <span className="text-white/40 text-sm font-normal">
                {g.events.length} {g.events.length === 1 ? 'event' : 'events'}
              </span>
            </h3>
          </div>
          <ol className="relative space-y-4 pl-6 border-l border-white/10">
            {g.events.map((ev) => (
              <TimelineRow key={ev.event_id} event={ev} accent={accent} mode={mode} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}

function TimelineRow({
  event,
  accent,
  mode,
}: {
  event: CalendarTimelineEvent
  accent: string
  mode: 'upcoming' | 'past'
}) {
  const start = event.event_start ? new Date(event.event_start) : null
  const dimmed = mode === 'past'

  return (
    <li className="relative">
      <span
        className="absolute -left-[31px] top-6 w-3 h-3 rounded-full ring-4 ring-black"
        style={{ backgroundColor: accent }}
      />
      <Link
        href={`/events/${event.event_slug || event.event_id}`}
        className={[
          'group block overflow-hidden transition-all duration-200 hover:brightness-110',
          dimmed ? 'opacity-90' : '',
        ].join(' ')}
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
        <div className="grid grid-cols-[7rem_1fr] sm:grid-cols-[10rem_1fr]">
          <div
            className={[
              'relative bg-cover bg-center',
              dimmed ? 'opacity-80 grayscale-[20%]' : '',
            ].join(' ')}
            style={{
              // Inline minHeight: the portal's Tailwind v4 content scan
              // doesn't reach cloned module repos under /tmp/module-repos,
              // so arbitrary-value classes (min-h-[7rem]) end up unbuilt
              // and the image column collapses on short cards.
              minHeight: '8rem',
              ...(event.event_logo || event.screenshot_url
                ? { backgroundImage: `url(${event.event_logo || event.screenshot_url})` }
                : {
                    background: event.gradient_color_1
                      ? `linear-gradient(135deg, ${event.gradient_color_1}, ${event.gradient_color_2 || event.gradient_color_1})`
                      : `linear-gradient(135deg, ${accent}88, ${accent}44)`,
                  }),
            }}
          >
            {event.is_featured && (
              <span className="absolute top-2 left-2 inline-block px-2 py-0.5 rounded-full bg-black/60 text-white text-[10px] font-medium">
                Featured
              </span>
            )}
          </div>
          <div className="p-4 sm:p-5">
            {start && (
              <div className="text-white/60 text-xs mb-1">
                {start.toLocaleDateString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}
                {' · '}
                {start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
              </div>
            )}
            <h4 className="text-white text-base sm:text-lg font-semibold leading-snug group-hover:underline underline-offset-2 decoration-1 line-clamp-2">
              {event.event_title}
            </h4>
            {formatLocationLabel(event) && (
              <p className="text-white/50 text-xs mt-1 line-clamp-1">
                {formatLocationLabel(event)}
              </p>
            )}
            <div className="mt-3">
              <StatPills event={event} mode={mode} compact />
            </div>
          </div>
        </div>
      </Link>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Stat pills — small badges below the title showing speaker/attendee/media
// counts. Compact mode shrinks padding for the timeline list cards.
// ---------------------------------------------------------------------------

function StatPills({
  event,
  mode,
  compact,
}: {
  event: CalendarTimelineEvent
  mode: 'upcoming' | 'past'
  compact?: boolean
}) {
  const pills: { icon: string; label: string }[] = []
  if (event.speaker_count > 0) {
    pills.push({
      icon: '🎤',
      label: `${event.speaker_count} ${event.speaker_count === 1 ? 'speaker' : 'speakers'}`,
    })
  }
  if (mode === 'upcoming' && event.registration_count > 0) {
    pills.push({
      icon: '👥',
      label: `${event.registration_count} registered`,
    })
  }
  if (mode === 'past' && event.attended_count > 0) {
    pills.push({
      icon: '✅',
      label: `${event.attended_count} attended`,
    })
  }
  if (event.media_count > 0) {
    pills.push({
      icon: '📷',
      label: `${event.media_count} ${event.media_count === 1 ? 'photo' : 'photos'}`,
    })
  }
  if (pills.length === 0) return null
  const padding = compact ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'
  return (
    <div className="flex flex-wrap gap-1.5">
      {pills.map((p) => (
        <span
          key={p.label}
          className={`inline-flex items-center gap-1 rounded-full bg-white/5 text-white/80 ${padding}`}
        >
          <span aria-hidden>{p.icon}</span>
          {p.label}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty state.
// ---------------------------------------------------------------------------

function EmptyState({
  title,
  body,
  primary,
  secondary,
}: {
  title: string
  body: string
  primary: { href: string; label: string }
  secondary?: { href: string; label: string }
}) {
  return (
    <div
      className="text-center overflow-hidden"
      style={{
        // Padding declared inline so it survives the Tailwind purge for
        // module files that aren't always in the JIT content scan.
        padding: '4rem 2.5rem',
        borderRadius: 'var(--radius-control, 12px)',
        backgroundColor: `rgba(var(--panel-tint, 0,0,0), var(--glass-opacity, 0.05))`,
        backdropFilter: `blur(var(--glass-blur, 4px))`,
        WebkitBackdropFilter: `blur(var(--glass-blur, 4px))`,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: `rgba(var(--panel-tint, 0,0,0), var(--glass-border-opacity, 0.1))`,
      }}
    >
      <h3 className="text-white text-xl font-bold">{title}</h3>
      <p className="text-white/60 text-sm mt-2 max-w-md mx-auto">{body}</p>
      <div className="flex items-center justify-center gap-3 mt-6">
        <Link
          href={primary.href}
          className="px-5 py-2 rounded-lg bg-black text-white text-sm font-semibold hover:bg-black/80"
        >
          {primary.label}
        </Link>
        {secondary && (
          <Link
            href={secondary.href}
            className="px-5 py-2 rounded-lg bg-white/10 text-white text-sm font-medium hover:bg-white/20"
          >
            {secondary.label}
          </Link>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

// Some scrapers populate `event_location` with raw "lat,lng" coordinates
// (e.g. Luma's geocoded venue field). Showing that in the listing UI looks
// like a bug, so detect coordinate-shaped strings and fall through to the
// city / country fields instead.
const COORDINATES_RE = /^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/

function formatLocationLabel(event: {
  event_location?: string | null
  event_city?: string | null
  event_country_code?: string | null
}): string {
  const loc = event.event_location?.trim()
  if (loc && !COORDINATES_RE.test(loc)) return loc
  return [event.event_city, event.event_country_code].filter(Boolean).join(', ')
}

function groupByMonth(events: CalendarTimelineEvent[]): MonthGroup[] {
  const out: MonthGroup[] = []
  for (const ev of events) {
    if (!ev.event_start) continue
    const d = new Date(ev.event_start)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    let group = out[out.length - 1]
    if (!group || group.key !== key) {
      group = {
        key,
        label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        events: [],
      }
      out.push(group)
    }
    group.events.push(ev)
  }
  return out
}
