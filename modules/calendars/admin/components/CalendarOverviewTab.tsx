import { useState, useEffect } from 'react';
import {
  CalendarIcon,
  UserGroupIcon,
  ChartBarIcon,
  TicketIcon,
  CheckCircleIcon,
  HeartIcon,
} from '@heroicons/react/24/outline';
import { Card } from '@/components/ui';
import { Calendar, CalendarStats, CalendarService } from '../services/calendarService';

interface CalendarOverviewTabProps {
  calendar: Calendar;
  stats: CalendarStats | null;
  onRefresh: () => void;
}

export function CalendarOverviewTab({ calendar, stats, onRefresh }: CalendarOverviewTabProps) {
  const [monthEvents, setMonthEvents] = useState<any[]>([]);
  const [currentMonth, setCurrentMonth] = useState(new Date());

  useEffect(() => {
    loadMonthEvents();
  }, [calendar.id, currentMonth]);

  const loadMonthEvents = async () => {
    const result = await CalendarService.getCalendarEventsForMonth(
      calendar.id,
      currentMonth.getFullYear(),
      currentMonth.getMonth() + 1
    );
    if (result.success && result.data) {
      setMonthEvents(result.data);
    }
  };

  const navigateMonth = (direction: number) => {
    setCurrentMonth(prev => {
      const newDate = new Date(prev);
      newDate.setMonth(newDate.getMonth() + direction);
      return newDate;
    });
  };

  // Generate calendar grid
  const generateCalendarDays = () => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startOffset = firstDay.getDay();
    const daysInMonth = lastDay.getDate();

    const days: { date: Date | null; events: any[] }[] = [];

    // Add empty slots for days before the first of the month
    for (let i = 0; i < startOffset; i++) {
      days.push({ date: null, events: [] });
    }

    // Add days of the month
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day);
      const dayEvents = monthEvents.filter(event => {
        const eventDate = new Date(event.event_start);
        return eventDate.getDate() === day &&
               eventDate.getMonth() === month &&
               eventDate.getFullYear() === year;
      });
      days.push({ date, events: dayEvents });
    }

    return days;
  };

  const calendarDays = generateCalendarDays();

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <Card skin="shadow" className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg">
              <CalendarIcon className="size-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <div className="text-xs font-medium text-neutral-500">Total Events</div>
              <div className="text-xl font-bold">{stats?.total_events ?? 0}</div>
            </div>
          </div>
        </Card>

        <Card skin="shadow" className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-green-100 dark:bg-green-900/30 rounded-lg">
              <CalendarIcon className="size-5 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <div className="text-xs font-medium text-neutral-500">Upcoming</div>
              <div className="text-xl font-bold">{stats?.upcoming_events ?? 0}</div>
            </div>
          </div>
        </Card>

        <Card skin="shadow" className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-100 dark:bg-purple-900/30 rounded-lg">
              <UserGroupIcon className="size-5 text-purple-600 dark:text-purple-400" />
            </div>
            <div>
              <div className="text-xs font-medium text-neutral-500">People</div>
              <div className="text-xl font-bold">{stats?.total_members ?? 0}</div>
            </div>
          </div>
        </Card>

        <Card skin="shadow" className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-pink-100 dark:bg-pink-900/30 rounded-lg">
              <HeartIcon className="size-5 text-pink-600 dark:text-pink-400" />
            </div>
            <div>
              <div className="text-xs font-medium text-neutral-500">Interested</div>
              <div className="text-xl font-bold">{stats?.total_interested ?? 0}</div>
            </div>
          </div>
        </Card>

        <Card skin="shadow" className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-yellow-100 dark:bg-yellow-900/30 rounded-lg">
              <TicketIcon className="size-5 text-yellow-600 dark:text-yellow-400" />
            </div>
            <div>
              <div className="text-xs font-medium text-neutral-500">Registered</div>
              <div className="text-xl font-bold">{stats?.total_registered ?? 0}</div>
            </div>
          </div>
        </Card>

        <Card skin="shadow" className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-teal-100 dark:bg-teal-900/30 rounded-lg">
              <CheckCircleIcon className="size-5 text-teal-600 dark:text-teal-400" />
            </div>
            <div>
              <div className="text-xs font-medium text-neutral-500">Attended</div>
              <div className="text-xl font-bold">{stats?.total_attended ?? 0}</div>
            </div>
          </div>
        </Card>
      </div>

      {/* Luma rollup. Only shown when the calendar has at least one event with
          a Luma guest count — otherwise these cards would just read "0" and
          add noise for calendars not driven by Luma scrapers. */}
      {(stats?.events_with_luma_data ?? 0) > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">Luma attendance</h3>
            <span className="text-xs text-neutral-500">Across {stats?.events_with_luma_data} event{stats?.events_with_luma_data === 1 ? '' : 's'} with Luma data</span>
          </div>
          {/* Ticket cards hidden — Luma's ticket_count mirrors guest_count for
              ~98% of events, so showing it alongside guest counts is redundant.
              RPC still returns the values if you want them later. */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card skin="shadow" className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg">
                  <UserGroupIcon className="size-5 text-indigo-600 dark:text-indigo-400" />
                </div>
                <div>
                  <div className="text-xs font-medium text-neutral-500">Total guests</div>
                  <div className="text-xl font-bold">{(stats?.total_luma_guests ?? 0).toLocaleString()}</div>
                </div>
              </div>
            </Card>

            <Card skin="shadow" className="p-4" title="Trimmed mean — drops the top and bottom 10% of events. See Reports tab for full breakdown.">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg">
                  <ChartBarIcon className="size-5 text-indigo-600 dark:text-indigo-400" />
                </div>
                <div>
                  <div className="text-xs font-medium text-neutral-500">Avg guests / event</div>
                  <div className="text-xl font-bold">{(stats?.trimmed_mean_luma_guests_all_time ?? stats?.avg_luma_guests_all_time ?? 0).toLocaleString()}</div>
                  <div className="text-[11px] text-neutral-500 mt-0.5">All time · outliers excluded</div>
                </div>
              </div>
            </Card>

            <Card skin="shadow" className="p-4" title="Trimmed mean — drops the top and bottom 10% of events. See Reports tab for full breakdown.">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg">
                  <ChartBarIcon className="size-5 text-indigo-600 dark:text-indigo-400" />
                </div>
                <div>
                  <div className="text-xs font-medium text-neutral-500">Avg guests / event</div>
                  <div className="text-xl font-bold">{(stats?.trimmed_mean_luma_guests_6mo ?? stats?.avg_luma_guests_6mo ?? 0).toLocaleString()}</div>
                  <div className="text-[11px] text-neutral-500 mt-0.5">Last 6 months · outliers excluded</div>
                </div>
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* Calendar View */}
      <Card skin="shadow" className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">
            {currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </h2>
          <div className="flex gap-2">
            <button
              onClick={() => navigateMonth(-1)}
              className="px-3 py-1 text-sm bg-gray-100 dark:bg-gray-800 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
            >
              Previous
            </button>
            <button
              onClick={() => setCurrentMonth(new Date())}
              className="px-3 py-1 text-sm bg-gray-100 dark:bg-gray-800 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
            >
              Today
            </button>
            <button
              onClick={() => navigateMonth(1)}
              className="px-3 py-1 text-sm bg-gray-100 dark:bg-gray-800 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
            >
              Next
            </button>
          </div>
        </div>

        {/* Calendar Grid */}
        <table className="w-full border-collapse table-fixed">
          <thead>
            <tr>
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                <th key={day} className="text-center text-xs font-medium text-[var(--gray-a8)] py-2 border-b border-[var(--gray-a3)]">
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Chunk calendarDays into weeks of 7 */}
            {Array.from({ length: Math.ceil(calendarDays.length / 7) }, (_, weekIndex) => (
              <tr key={weekIndex}>
                {calendarDays.slice(weekIndex * 7, weekIndex * 7 + 7).map((day, dayIndex) => (
                  <td
                    key={dayIndex}
                    className={`h-24 align-top p-1.5 border border-[var(--gray-a3)] ${
                      day.date
                        ? isToday(day.date)
                          ? 'bg-[var(--accent-a2)]'
                          : ''
                        : 'bg-[var(--gray-a2)]'
                    }`}
                  >
                    {day.date && (
                      <>
                        <div className={`text-xs font-medium mb-1 ${
                          isToday(day.date)
                            ? 'text-[var(--accent-11)] font-bold'
                            : 'text-[var(--gray-a9)]'
                        }`}>
                          {day.date.getDate()}
                        </div>
                        <div className="space-y-0.5">
                          {day.events.slice(0, 3).map((event: any, eventIndex: number) => (
                            <div
                              key={eventIndex}
                              className="text-[10px] leading-tight px-1 py-0.5 rounded truncate"
                              style={{
                                backgroundColor: (calendar.color || '#3b82f6') + '20',
                                color: calendar.color || '#3b82f6',
                              }}
                              title={event.event_title}
                            >
                              {event.event_title}
                            </div>
                          ))}
                          {day.events.length > 3 && (
                            <div className="text-[10px] text-[var(--gray-a8)]">
                              +{day.events.length - 3} more
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </td>
                ))}
                {/* Pad last row if it has fewer than 7 cells */}
                {calendarDays.slice(weekIndex * 7, weekIndex * 7 + 7).length < 7 &&
                  Array.from({ length: 7 - calendarDays.slice(weekIndex * 7, weekIndex * 7 + 7).length }, (_, i) => (
                    <td key={`pad-${i}`} className="h-24 border border-[var(--gray-a3)] bg-[var(--gray-a2)]" />
                  ))
                }
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Calendar Info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card skin="shadow" className="p-6">
          <h3 className="text-lg font-semibold mb-4">Calendar Details</h3>
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-gray-500">ID</span>
              <span className="font-mono text-sm">{calendar.calendarId}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Visibility</span>
              <span className="capitalize">{calendar.visibility}</span>
            </div>
            {calendar.lumaCalendarId && (
              <div className="flex justify-between">
                <span className="text-gray-500">Luma ID</span>
                <span className="font-mono text-sm">{calendar.lumaCalendarId}</span>
              </div>
            )}
            {calendar.externalUrl && (
              <div className="flex justify-between">
                <span className="text-gray-500">External URL</span>
                <a
                  href={calendar.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary-600 dark:text-primary-400 hover:underline truncate max-w-48"
                >
                  {calendar.externalUrl}
                </a>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-gray-500">Created</span>
              <span>{new Date(calendar.createdAt).toLocaleDateString()}</span>
            </div>
          </div>
        </Card>

        {calendar.description && (
          <Card skin="shadow" className="p-6">
            <h3 className="text-lg font-semibold mb-4">Description</h3>
            <p className="text-gray-600 dark:text-gray-400">{calendar.description}</p>
          </Card>
        )}
      </div>
    </div>
  );
}

function isToday(date: Date): boolean {
  const today = new Date();
  return date.getDate() === today.getDate() &&
         date.getMonth() === today.getMonth() &&
         date.getFullYear() === today.getFullYear();
}
