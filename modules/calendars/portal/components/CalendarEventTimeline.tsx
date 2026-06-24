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
      <CalTimelineStyles />
      <div className="pub-seg cal-tl-seg" style={{ marginBottom: 24, flexWrap: 'wrap' }}>
        {TAB_LABELS.map((t) => {
          const active = t.value === view
          const count = t.value === 'upcoming' ? upcoming.length : t.value === 'past' ? past.length : null
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setView(t.value)}
              className={`pub-seg-btn${active ? ' on' : ''}`}
              style={active ? { backgroundColor: primaryColor, color: lightPrimary ? '#000000' : '#ffffff' } : undefined}
            >
              <span>{t.label}</span>
              {typeof count === 'number' && count > 0 && (
                <span
                  className="cnt"
                  style={active ? { background: lightPrimary ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.22)', color: lightPrimary ? '#000' : '#fff' } : undefined}
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
    <Link href={`/events/${event.event_slug || event.event_id}`} className="cal-tl-hero">
      <div className="cal-tl-hero-grid">
        <div
          className="cal-tl-hero-img"
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
            <div className="cal-tl-feat">
              <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>
              Featured
            </div>
          )}
        </div>
        <div className="cal-tl-hero-body">
          {start && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ font: '600 11px var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-4)' }}>
                  {start.toLocaleDateString(undefined, { month: 'short' })}
                </div>
                <div style={{ font: '600 30px var(--font-display)', color: 'var(--ink)', lineHeight: 1 }}>
                  {start.getDate()}
                </div>
              </div>
              <div style={{ fontSize: 14, color: 'var(--ink-3)' }}>
                <div>{start.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric' })}</div>
                <div>{start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}{event.event_timezone ? ` · ${event.event_timezone}` : ''}</div>
              </div>
            </div>
          )}
          <h3 className="cal-tl-hero-title">{event.event_title}</h3>
          {formatLocationLabel(event) && (
            <p style={{ color: 'var(--ink-3)', fontSize: 14, margin: '0 0 20px' }}>
              📍 {formatLocationLabel(event)}
            </p>
          )}

          <StatPills event={event} mode="upcoming" />

          <span className="btn btn-primary" style={{ marginTop: 24, width: 'fit-content' }}>
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
        <section key={g.key} style={i === 0 ? undefined : { marginTop: 48 }}>
          <div style={{ marginBottom: 20, paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
            <h3 style={{ font: '600 18px var(--font-display)', color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 12, margin: 0 }}>
              {g.label}
              <span style={{ color: 'var(--ink-4)', fontSize: 14, fontWeight: 400 }}>
                {g.events.length} {g.events.length === 1 ? 'event' : 'events'}
              </span>
            </h3>
          </div>
          <ol className="cal-tl-list">
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
    <li style={{ position: 'relative' }}>
      <span
        className="cal-tl-node"
        style={{ backgroundColor: accent }}
      />
      <Link
        href={`/events/${event.event_slug || event.event_id}`}
        className="cal-tl-card"
        style={dimmed ? { opacity: 0.9 } : undefined}
      >
        <div className="cal-tl-card-grid">
          <div
            className="cal-tl-card-img"
            style={{
              ...(dimmed ? { filter: 'grayscale(20%)', opacity: 0.85 } : {}),
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
              <span className="cal-tl-feat-sm">Featured</span>
            )}
          </div>
          <div style={{ padding: '16px 18px' }}>
            {start && (
              <div style={{ color: 'var(--ink-4)', fontSize: 12, marginBottom: 4 }}>
                {start.toLocaleDateString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}
                {' · '}
                {start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
              </div>
            )}
            <h4 className="cal-tl-card-title">
              {event.event_title}
            </h4>
            {formatLocationLabel(event) && (
              <p className="cal-tl-card-loc">
                {formatLocationLabel(event)}
              </p>
            )}
            <div style={{ marginTop: 12 }}>
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
  const padStyle: React.CSSProperties = compact
    ? { padding: '2px 8px', fontSize: 11 }
    : { padding: '4px 12px', fontSize: 12 }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {pills.map((p) => (
        <span
          key={p.label}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 999, background: 'rgba(var(--ui-text), 0.06)', color: 'var(--ink-2)', ...padStyle }}
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
      style={{
        textAlign: 'center',
        overflow: 'hidden',
        padding: '4rem 2.5rem',
        borderRadius: 18,
        background: 'var(--paper)',
        border: '1px solid var(--line)',
      }}
    >
      <h3 style={{ font: '600 20px var(--font-display)', color: 'var(--ink)', margin: 0 }}>{title}</h3>
      <p style={{ color: 'var(--ink-3)', fontSize: 14, marginTop: 8, maxWidth: '28rem', marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.55 }}>{body}</p>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 24 }}>
        <Link href={primary.href} className="btn btn-primary">
          {primary.label}
        </Link>
        {secondary && (
          <Link href={secondary.href} className="btn btn-secondary">
            {secondary.label}
          </Link>
        )}
      </div>
    </div>
  )
}

/**
 * Scoped styles for the event timeline (tab seg, hero card, month-grouped
 * spine + cards). Rendered once at the top of <CalendarEventTimeline>.
 */
function CalTimelineStyles() {
  return (
    <style>{`
      .cal-tl-seg { display: inline-flex; }
      @media (max-width: 640px) { .cal-tl-seg { display: flex; width: 100%; } .cal-tl-seg .pub-seg-btn { flex: 1; } }
      .cal-tl-hero { display: block; overflow: hidden; text-decoration: none; border-radius: 18px; background: var(--paper); border: 1px solid var(--line);
        transition: border-color .2s ease, transform .2s ease; }
      .cal-tl-hero:hover { border-color: var(--line-2); transform: translateY(-2px); }
      .cal-tl-hero-grid { display: grid; grid-template-columns: 1fr; }
      @media (min-width: 768px) { .cal-tl-hero-grid { grid-template-columns: 1fr 1fr; } }
      .cal-tl-hero-img { position: relative; aspect-ratio: 16/10; background-size: cover; background-position: center; }
      @media (min-width: 768px) { .cal-tl-hero-img { aspect-ratio: auto; min-height: 100%; } }
      .cal-tl-hero-body { padding: 24px; display: flex; flex-direction: column; justify-content: center; }
      @media (min-width: 768px) { .cal-tl-hero-body { padding: 40px; } }
      .cal-tl-hero-title { font: 600 clamp(22px,3vw,30px) var(--font-display); color: var(--ink); letter-spacing: -0.015em; margin: 0 0 12px; }
      .cal-tl-hero:hover .cal-tl-hero-title { text-decoration: underline; text-underline-offset: 4px; }
      .cal-tl-feat { position: absolute; top: 16px; left: 16px; display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px;
        background: rgba(0,0,0,0.6); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); color: #fff; font-size: 12px; font-weight: 500; }
      .cal-tl-list { list-style: none; margin: 0; padding: 0 0 0 24px; display: flex; flex-direction: column; gap: 16px; position: relative; border-left: 1px solid var(--line); }
      .cal-tl-node { position: absolute; left: -31px; top: 24px; width: 12px; height: 12px; border-radius: 50%; box-shadow: 0 0 0 4px var(--paper); }
      .cal-tl-card { display: block; overflow: hidden; text-decoration: none; border-radius: 14px; background: var(--paper); border: 1px solid rgba(var(--ui-text), 0.10);
        transition: border-color .2s ease, transform .2s ease; }
      .cal-tl-card:hover { border-color: rgba(var(--ui-text), 0.28); transform: translateY(-2px); }
      .cal-tl-card-grid { display: grid; grid-template-columns: 7rem 1fr; }
      @media (min-width: 640px) { .cal-tl-card-grid { grid-template-columns: 10rem 1fr; } }
      .cal-tl-card-img { position: relative; background-size: cover; background-position: center; min-height: 8rem; background-color: rgba(var(--ui-text), 0.05); }
      .cal-tl-feat-sm { position: absolute; top: 8px; left: 8px; display: inline-block; padding: 2px 8px; border-radius: 999px; background: rgba(0,0,0,0.6); color: #fff; font-size: 10px; font-weight: 500; }
      .cal-tl-card-title { font: 600 17px var(--font-display); color: var(--ink); line-height: 1.3; margin: 0;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .cal-tl-card:hover .cal-tl-card-title { text-decoration: underline; text-underline-offset: 2px; }
      .cal-tl-card-loc { color: var(--ink-3); font-size: 12px; margin: 4px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `}</style>
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
