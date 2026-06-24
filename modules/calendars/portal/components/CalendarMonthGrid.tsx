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
  const accent = brandColor || 'var(--accent)'

  return (
    <div>
      <style>{`
        .cal-mg-nav-btn { width: 36px; height: 36px; display: inline-flex; align-items: center; justify-content: center; border-radius: 10px;
          background: rgba(var(--ui-text), 0.05); color: var(--ink); border: 1px solid var(--line); cursor: pointer; transition: background .15s ease; }
        .cal-mg-nav-btn:hover { background: rgba(var(--ui-text), 0.1); }
        .cal-mg-today { width: auto; padding: 0 12px; font-size: 12px; }
        .cal-mg-frame { border-radius: 18px; border: 1px solid var(--line); overflow: hidden; }
        .cal-mg-dow { display: grid; grid-template-columns: repeat(7, 1fr); background: rgba(var(--ui-text), 0.03); border-bottom: 1px solid var(--line); }
        .cal-mg-dow > div { padding: 8px 12px; font: 600 11px var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-4); text-align: center; }
        .cal-mg-grid { display: grid; grid-template-columns: repeat(7, 1fr); grid-auto-rows: minmax(7.5rem, 1fr); }
        .cal-mg-cell { position: relative; text-align: left; padding: 8px; border-right: 1px solid rgba(var(--ui-text), 0.06); border-bottom: 1px solid rgba(var(--ui-text), 0.06);
          background: transparent; transition: background .15s ease; }
        .cal-mg-cell.out { background: rgba(var(--ui-text), 0.02); }
        .cal-mg-cell.has:hover { background: rgba(var(--ui-text), 0.06); cursor: pointer; }
        .cal-mg-cell:disabled { cursor: default; }
        .cal-mg-cell.sel { background: rgba(var(--ui-text), 0.08); box-shadow: inset 0 0 0 1px var(--line-2); }
        .cal-mg-daynum { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; font: 600 12px var(--font-sans); color: var(--ink); }
        .cal-mg-daynum.out { color: var(--ink-4); }
        .cal-mg-count { font-size: 10px; color: var(--ink-4); }
        .cal-mg-chip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 1.3; padding: 2px 8px; border-radius: 6px;
          background: rgba(var(--ui-text), 0.1); color: var(--ink-2); }
        .cal-mg-more { font-size: 10px; color: var(--ink-4); padding: 0 4px; }
        .cal-mg-evrow { display: flex; align-items: center; gap: 16px; padding: 12px; border-radius: 12px; text-decoration: none;
          background: var(--paper); border: 1px solid rgba(var(--ui-text), 0.10); transition: border-color .2s ease, transform .2s ease; }
        .cal-mg-evrow:hover { border-color: rgba(var(--ui-text), 0.28); transform: translateY(-2px); }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h3 style={{ font: '600 20px var(--font-display)', color: 'var(--ink)', margin: 0 }}>{monthLabel}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            onClick={() => {
              setCursor(addMonths(cursor, -1))
              setSelectedDayKey(null)
            }}
            className="cal-mg-nav-btn"
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
            className="cal-mg-nav-btn cal-mg-today"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => {
              setCursor(addMonths(cursor, 1))
              setSelectedDayKey(null)
            }}
            className="cal-mg-nav-btn"
            aria-label="Next month"
          >
            ›
          </button>
        </div>
      </div>

      <div className="cal-mg-frame">
        <div className="cal-mg-dow">
          {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((d) => (
            <div key={d}>{d}</div>
          ))}
        </div>
        <div className="cal-mg-grid">
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
                  'cal-mg-cell',
                  inMonth ? '' : 'out',
                  list.length > 0 ? 'has' : '',
                  isSelected ? 'sel' : '',
                ].join(' ')}
              >
                {cell && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span
                        className={`cal-mg-daynum${inMonth ? '' : ' out'}`}
                        style={isToday ? { backgroundColor: accent, color: '#000' } : undefined}
                      >
                        {cell.getDate()}
                      </span>
                      {list.length > 0 && (
                        <span className="cal-mg-count">{list.length}</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {list.slice(0, 2).map((ev) => (
                        <div key={ev.event_id} className="cal-mg-chip" title={ev.event_title}>
                          {ev.event_title}
                        </div>
                      ))}
                      {list.length > 2 && (
                        <div className="cal-mg-more">+{list.length - 2} more</div>
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
        <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h4 style={{ color: 'var(--ink-3)', fontSize: 14, margin: 0 }}>
            {new Date(selectedDayKey + 'T00:00:00').toLocaleDateString(undefined, {
              weekday: 'long', month: 'long', day: 'numeric',
            })}
          </h4>
          {selectedEvents.map((ev) => (
            <Link
              key={ev.event_id}
              href={`/events/${ev.event_slug || ev.event_id}`}
              className="cal-mg-evrow"
            >
              {(ev.event_logo || ev.screenshot_url) ? (
                <div
                  style={{ width: 56, height: 56, borderRadius: 11, flexShrink: 0, backgroundImage: `url(${ev.event_logo || ev.screenshot_url})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
                />
              ) : (
                <div
                  style={{
                    width: 56, height: 56, borderRadius: 11, flexShrink: 0,
                    background: ev.gradient_color_1
                      ? `linear-gradient(135deg, ${ev.gradient_color_1}, ${ev.gradient_color_2 || ev.gradient_color_1})`
                      : 'rgba(var(--ui-text), 0.06)',
                  }}
                />
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ color: 'var(--ink-4)', fontSize: 12 }}>
                  {ev.event_start ? new Date(ev.event_start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''}
                </div>
                <div style={{ color: 'var(--ink)', fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.event_title}</div>
                {(ev.event_city || ev.event_country_code) && (
                  <div style={{ color: 'var(--ink-3)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
