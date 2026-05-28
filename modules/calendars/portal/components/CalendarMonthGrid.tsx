// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import type { CalendarTimelineEvent } from '../lib/types'

interface Props {
  events: CalendarTimelineEvent[]
  brandColor?: string | null
}

/**
 * Month-grid calendar view. Lays out a 6-row x 7-column grid for the active
 * month, with event chips on each day. Click an event to jump to its page,
 * click a day with hidden events to expand below the grid.
 */
export function CalendarMonthGrid({ events, brandColor }: Props) {
  // Pick the initial month: month of the first upcoming event, or current.
  const initialMonth = useMemo(() => {
    const future = events.find((e) => e.event_start && e.event_start >= new Date().toISOString())
    if (future?.event_start) return startOfMonth(new Date(future.event_start))
    return startOfMonth(new Date())
  }, [events])

  const [cursor, setCursor] = useState<Date>(initialMonth)
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null)

  const grid = useMemo(() => buildGrid(cursor), [cursor])

  // Group events by yyyy-mm-dd (local date) so we can attach them to grid cells.
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarTimelineEvent[]>()
    for (const ev of events) {
      if (!ev.event_start) continue
      const key = dayKey(new Date(ev.event_start))
      const list = map.get(key) || []
      list.push(ev)
      map.set(key, list)
    }
    // Each list is already in event_start order — events array comes pre-sorted.
    return map
  }, [events])

  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const todayKey = dayKey(new Date())

  const selectedEvents = selectedDayKey ? eventsByDay.get(selectedDayKey) || [] : []
  const accent = brandColor || '#ffffff'

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-white text-xl font-semibold">{monthLabel}</h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setCursor(addMonths(cursor, -1))
              setSelectedDayKey(null)
            }}
            className="w-9 h-9 inline-flex items-center justify-center rounded-lg bg-white/5 hover:bg-white/10 text-white border border-white/10"
            aria-label="Previous month"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => {
              setCursor(startOfMonth(new Date()))
              setSelectedDayKey(null)
            }}
            className="px-3 h-9 inline-flex items-center rounded-lg bg-white/5 hover:bg-white/10 text-white text-xs border border-white/10"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => {
              setCursor(addMonths(cursor, 1))
              setSelectedDayKey(null)
            }}
            className="w-9 h-9 inline-flex items-center justify-center rounded-lg bg-white/5 hover:bg-white/10 text-white border border-white/10"
            aria-label="Next month"
          >
            ›
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 overflow-hidden">
        <div className="grid grid-cols-7 bg-white/[0.03] border-b border-white/10">
          {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((d) => (
            <div key={d} className="px-3 py-2 text-[11px] uppercase tracking-wider text-white/50 text-center">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 auto-rows-[minmax(7.5rem,1fr)]">
          {grid.map((cell, i) => {
            const key = cell ? dayKey(cell) : `pad-${i}`
            const list = cell ? eventsByDay.get(key) || [] : []
            const inMonth = cell && cell.getMonth() === cursor.getMonth()
            const isToday = cell && key === todayKey
            const isSelected = key === selectedDayKey
            return (
              <button
                key={key}
                type="button"
                onClick={() => cell && list.length > 0 && setSelectedDayKey(isSelected ? null : key)}
                disabled={!cell || list.length === 0}
                className={[
                  'relative text-left p-2 border-r border-b border-white/5 last:border-r-0 transition-colors',
                  inMonth ? 'bg-transparent' : 'bg-white/[0.02] text-white/30',
                  list.length > 0 ? 'hover:bg-white/[0.06] cursor-pointer' : 'cursor-default',
                  isSelected ? 'bg-white/[0.08] ring-1 ring-inset ring-white/30' : '',
                ].join(' ')}
              >
                {cell && (
                  <>
                    <div className="flex items-center justify-between mb-1">
                      <span
                        className={[
                          'inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold',
                          isToday ? 'text-black' : inMonth ? 'text-white' : 'text-white/30',
                        ].join(' ')}
                        style={isToday ? { backgroundColor: accent } : undefined}
                      >
                        {cell.getDate()}
                      </span>
                      {list.length > 0 && (
                        <span className="text-[10px] text-white/50">{list.length}</span>
                      )}
                    </div>
                    <div className="space-y-1">
                      {list.slice(0, 2).map((ev) => (
                        <div
                          key={ev.event_id}
                          className="truncate text-[11px] leading-tight px-2 py-1 rounded bg-white/10 text-white/90"
                          title={ev.event_title}
                        >
                          {ev.event_title}
                        </div>
                      ))}
                      {list.length > 2 && (
                        <div className="text-[10px] text-white/50 px-1">
                          +{list.length - 2} more
                        </div>
                      )}
                    </div>
                  </>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {selectedEvents.length > 0 && (
        <div className="mt-6 space-y-3">
          <h4 className="text-white/70 text-sm">
            {new Date(selectedDayKey + 'T00:00:00').toLocaleDateString(undefined, {
              weekday: 'long', month: 'long', day: 'numeric',
            })}
          </h4>
          {selectedEvents.map((ev) => (
            <Link
              key={ev.event_id}
              href={`/events/${ev.event_slug || ev.event_id}`}
              className="flex items-center gap-4 p-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20"
            >
              {(ev.event_logo || ev.screenshot_url) ? (
                <div
                  className="w-14 h-14 rounded-lg flex-shrink-0 bg-cover bg-center"
                  style={{ backgroundImage: `url(${ev.event_logo || ev.screenshot_url})` }}
                />
              ) : (
                <div
                  className="w-14 h-14 rounded-lg flex-shrink-0"
                  style={{
                    background: ev.gradient_color_1
                      ? `linear-gradient(135deg, ${ev.gradient_color_1}, ${ev.gradient_color_2 || ev.gradient_color_1})`
                      : 'linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))',
                  }}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-white/60 text-xs">
                  {ev.event_start ? new Date(ev.event_start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''}
                </div>
                <div className="text-white text-sm font-medium truncate">{ev.event_title}</div>
                {(ev.event_city || ev.event_country_code) && (
                  <div className="text-white/50 text-xs truncate">
                    {[ev.event_city, ev.event_country_code].filter(Boolean).join(', ')}
                  </div>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Date helpers — kept local so the component is self-contained.
// ---------------------------------------------------------------------------

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

function dayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Build a 6-row x 7-column grid (Mon-first) for the cursor month, padded with
 * the trailing days of the previous month and leading days of the next.
 */
function buildGrid(cursor: Date): Date[] {
  const first = startOfMonth(cursor)
  // getDay(): 0=Sun ... 6=Sat. We want Monday as column 0.
  const offset = (first.getDay() + 6) % 7
  const start = new Date(first)
  start.setDate(first.getDate() - offset)
  const grid: Date[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    grid.push(d)
  }
  return grid
}
