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
import { Calendar, CalendarStats, CalendarService } from '@/lib/services/calendarService';

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
        <div className="grid grid-cols-7 gap-1">
          {/* Day headers */}
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
            <div key={day} className="text-center text-xs font-medium text-gray-500 py-2">
              {day}
            </div>
          ))}

          {/* Calendar days */}
          {calendarDays.map((day, index) => (
            <div
              key={index}
              className={`min-h-24 p-1 border border-gray-100 dark:border-gray-800 rounded ${
                day.date ? 'bg-white dark:bg-gray-900' : 'bg-gray-50 dark:bg-gray-950'
              }`}
            >
              {day.date && (
                <>
                  <div className={`text-xs font-medium mb-1 ${
                    isToday(day.date) ? 'text-primary-600 dark:text-primary-400' : 'text-gray-500'
                  }`}>
                    {day.date.getDate()}
                  </div>
                  <div className="space-y-1">
                    {day.events.slice(0, 3).map((event, eventIndex) => (
                      <div
                        key={eventIndex}
                        className="text-xs p-1 rounded truncate"
                        style={{ backgroundColor: calendar.color + '20', color: calendar.color }}
                        title={event.event_title}
                      >
                        {event.event_title}
                      </div>
                    ))}
                    {day.events.length > 3 && (
                      <div className="text-xs text-gray-400">
                        +{day.events.length - 3} more
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
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
