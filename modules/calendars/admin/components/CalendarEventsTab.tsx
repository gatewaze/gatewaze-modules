import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  PlusIcon,
  MagnifyingGlassIcon,
  TrashIcon,
  StarIcon,
  EyeIcon,
  ArrowPathIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  FunnelIcon,
} from '@heroicons/react/24/outline';
import { StarIcon as StarIconSolid } from '@heroicons/react/24/solid';
import { toast } from 'sonner';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  createColumnHelper,
  flexRender,
  SortingState,
} from '@tanstack/react-table';
import {
  Card,
  Button,
  Badge,
  Modal,
  ConfirmModal,
  Pagination,
  PaginationFirst,
  PaginationLast,
  PaginationNext,
  PaginationPrevious,
  PaginationItems,
} from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Calendar, CalendarService, CalendarEvent } from '@/lib/services/calendarService';
import { supabase } from '@/lib/supabase';

interface CalendarEventsTabProps {
  calendar: Calendar;
  onRefresh: () => void;
}

const PAGE_SIZE = 25;

type TimeFilter = 'all' | 'upcoming' | 'past';

const columnHelper = createColumnHelper<CalendarEvent>();

export function CalendarEventsTab({ calendar, onRefresh }: CalendarEventsTabProps) {
  const navigate = useNavigate();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'addedAt', desc: true }
  ]);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [removeEvent, setRemoveEvent] = useState<CalendarEvent | null>(null);
  const [availableEvents, setAvailableEvents] = useState<any[]>([]);
  const [searchingEvents, setSearchingEvents] = useState(false);
  const [eventSearch, setEventSearch] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [addingEvents, setAddingEvents] = useState(false);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');

  useEffect(() => {
    loadEvents();
  }, [calendar.id]);

  // Filter events by time
  const filteredEvents = useMemo(() => {
    if (timeFilter === 'all') return events;

    const now = new Date();
    return events.filter(event => {
      if (!event.event?.eventStart) return timeFilter === 'past'; // No date = treat as past
      const eventDate = new Date(event.event.eventStart);
      return timeFilter === 'upcoming' ? eventDate >= now : eventDate < now;
    });
  }, [events, timeFilter]);

  // Count events by time for filter badges
  const eventCounts = useMemo(() => {
    const now = new Date();
    let upcoming = 0;
    let past = 0;

    events.forEach(event => {
      if (!event.event?.eventStart) {
        past++;
      } else {
        const eventDate = new Date(event.event.eventStart);
        if (eventDate >= now) {
          upcoming++;
        } else {
          past++;
        }
      }
    });

    return { all: events.length, upcoming, past };
  }, [events]);

  const loadEvents = async () => {
    setLoading(true);
    try {
      const result = await CalendarService.getCalendarEvents(calendar.id);
      if (result.success && result.data) {
        setEvents(result.data);
      }
    } catch (error) {
      console.error('Error loading events:', error);
      toast.error('Failed to load events');
    } finally {
      setLoading(false);
    }
  };

  const searchAvailableEvents = async () => {
    if (!eventSearch.trim()) {
      setAvailableEvents([]);
      return;
    }

    setSearchingEvents(true);
    try {
      // Get events that are NOT already in this calendar
      const existingEventIds = events.map(e => e.eventId);

      const { data, error } = await supabase
        .from('events')
        .select('event_id, event_title, event_start, event_city, event_logo')
        .or(`event_title.ilike.%${eventSearch}%,event_id.ilike.%${eventSearch}%`)
        .not('event_id', 'in', existingEventIds.length > 0 ? `(${existingEventIds.join(',')})` : '()')
        .order('event_start', { ascending: false })
        .limit(50);

      if (error) throw error;
      setAvailableEvents(data || []);
    } catch (error) {
      console.error('Error searching events:', error);
      toast.error('Failed to search events');
    } finally {
      setSearchingEvents(false);
    }
  };

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (isAddModalOpen) {
        searchAvailableEvents();
      }
    }, 300);
    return () => clearTimeout(timeoutId);
  }, [eventSearch, isAddModalOpen]);

  const handleAddEvents = async () => {
    if (selectedEvents.length === 0) return;

    setAddingEvents(true);
    try {
      const result = await CalendarService.addEventsToCalendar(
        calendar.id,
        selectedEvents,
        'manual'
      );

      if (result.success) {
        toast.success(`Added ${result.data?.added || 0} events to calendar`);
        setIsAddModalOpen(false);
        setSelectedEvents([]);
        setEventSearch('');
        loadEvents();
        onRefresh();
      } else {
        toast.error(result.error || 'Failed to add events');
      }
    } catch (error) {
      toast.error('Failed to add events');
    } finally {
      setAddingEvents(false);
    }
  };

  const handleRemoveEvent = async () => {
    if (!removeEvent) return;

    try {
      const result = await CalendarService.removeEventsFromCalendar(
        calendar.id,
        [removeEvent.eventId]
      );

      if (result.success) {
        toast.success('Event removed from calendar');
        setRemoveEvent(null);
        loadEvents();
        onRefresh();
      } else {
        toast.error(result.error || 'Failed to remove event');
      }
    } catch (error) {
      toast.error('Failed to remove event');
    }
  };

  const handleToggleFeatured = async (event: CalendarEvent) => {
    try {
      const result = await CalendarService.updateCalendarEvent(
        calendar.id,
        event.eventId,
        { isFeatured: !event.isFeatured }
      );

      if (result.success) {
        toast.success(event.isFeatured ? 'Event unfeatured' : 'Event featured');
        loadEvents();
      } else {
        toast.error(result.error || 'Failed to update event');
      }
    } catch (error) {
      toast.error('Failed to update event');
    }
  };

  const columns = useMemo(
    () => [
      columnHelper.accessor('event', {
        header: 'Event',
        cell: (info) => {
          const event = info.getValue();
          return (
            <div className="flex items-center gap-3">
              {event?.eventLogo && (
                <img
                  src={event.eventLogo}
                  alt=""
                  className="w-10 h-10 rounded object-cover"
                />
              )}
              <div>
                <div className="font-medium text-gray-900 dark:text-white">
                  {event?.eventTitle || 'Unknown Event'}
                </div>
                <div className="text-xs text-gray-500">
                  {info.row.original.eventId}
                </div>
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor('event.eventStart', {
        header: 'Date',
        cell: (info) => {
          const dateStr = info.getValue();
          if (!dateStr) return '-';
          return new Date(dateStr).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          });
        },
      }),
      columnHelper.accessor('event.eventCity', {
        header: 'Location',
        cell: (info) => info.getValue() || '-',
      }),
      columnHelper.accessor('isFeatured', {
        header: 'Featured',
        cell: (info) => (
          <button
            onClick={() => handleToggleFeatured(info.row.original)}
            className="p-1"
            title={info.getValue() ? 'Remove from featured' : 'Add to featured'}
          >
            {info.getValue() ? (
              <StarIconSolid className="size-5 text-yellow-500" />
            ) : (
              <StarIcon className="size-5 text-gray-400 hover:text-yellow-500" />
            )}
          </button>
        ),
      }),
      columnHelper.accessor('addedVia', {
        header: 'Source',
        cell: (info) => (
          <Badge color="neutral" className="capitalize">
            {info.getValue()}
          </Badge>
        ),
      }),
      columnHelper.accessor('addedAt', {
        header: 'Added',
        cell: (info) => {
          const dateStr = info.getValue();
          if (!dateStr) return '-';
          return new Date(dateStr).toLocaleDateString();
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: 'Actions',
        cell: (info) => {
          const event = info.row.original;
          return (
            <div className="flex items-center gap-2">
              <button
                onClick={() => navigate(`/events/${event.eventId}`)}
                className="p-1 text-blue-600 hover:text-blue-800"
                title="View event"
              >
                <EyeIcon className="size-5" />
              </button>
              <button
                onClick={() => setRemoveEvent(event)}
                className="p-1 text-red-600 hover:text-red-800"
                title="Remove from calendar"
              >
                <TrashIcon className="size-5" />
              </button>
            </div>
          );
        },
      }),
    ],
    [navigate, calendar.id]
  );

  const table = useReactTable({
    data: filteredEvents,
    columns,
    state: {
      sorting,
      globalFilter,
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: {
        pageSize: PAGE_SIZE,
      },
    },
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold">Events</h2>
          <p className="text-sm text-gray-500">
            Manage events in this calendar
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            onClick={loadEvents}
            variant="outlined"
            className="gap-2"
            disabled={loading}
          >
            <ArrowPathIcon className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button onClick={() => setIsAddModalOpen(true)} className="gap-2">
            <PlusIcon className="size-4" />
            Add Events
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card skin="shadow" className="p-4">
        <div className="flex flex-col sm:flex-row gap-4">
          {/* Time Filter */}
          <div className="flex items-center gap-2">
            <FunnelIcon className="size-5 text-neutral-400" />
            <div className="flex rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
              <button
                onClick={() => setTimeFilter('all')}
                className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                  timeFilter === 'all'
                    ? 'bg-primary-600 text-white'
                    : 'bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                }`}
              >
                All ({eventCounts.all})
              </button>
              <button
                onClick={() => setTimeFilter('upcoming')}
                className={`px-3 py-1.5 text-sm font-medium border-l border-neutral-200 dark:border-neutral-700 transition-colors ${
                  timeFilter === 'upcoming'
                    ? 'bg-primary-600 text-white'
                    : 'bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                }`}
              >
                Upcoming ({eventCounts.upcoming})
              </button>
              <button
                onClick={() => setTimeFilter('past')}
                className={`px-3 py-1.5 text-sm font-medium border-l border-neutral-200 dark:border-neutral-700 transition-colors ${
                  timeFilter === 'past'
                    ? 'bg-primary-600 text-white'
                    : 'bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                }`}
              >
                Past ({eventCounts.past})
              </button>
            </div>
          </div>

          {/* Search */}
          <div className="relative flex-1">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-5 text-neutral-400" />
            <input
              type="text"
              placeholder="Search events..."
              value={globalFilter ?? ''}
              onChange={(e) => setGlobalFilter(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
        </div>
      </Card>

      {/* Events Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider"
                    >
                      {header.isPlaceholder ? null : (
                        <div
                          className={`flex items-center gap-2 ${
                            header.column.getCanSort() ? 'cursor-pointer select-none' : ''
                          }`}
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {header.column.getCanSort() && (
                            <span className="flex flex-col">
                              <ChevronUpIcon
                                className={`size-3 ${
                                  header.column.getIsSorted() === 'asc' ? 'text-blue-600' : 'text-gray-400'
                                }`}
                              />
                              <ChevronDownIcon
                                className={`size-3 -mt-1 ${
                                  header.column.getIsSorted() === 'desc' ? 'text-blue-600' : 'text-gray-400'
                                }`}
                              />
                            </span>
                          )}
                        </div>
                      )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {loading ? (
                <tr>
                  <td colSpan={7} className="text-center py-12">
                    <LoadingSpinner size="medium" />
                  </td>
                </tr>
              ) : table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-12">
                    <p className="text-gray-500">No events in this calendar</p>
                    <Button onClick={() => setIsAddModalOpen(true)} className="mt-4 gap-2">
                      <PlusIcon className="size-4" />
                      Add Events
                    </Button>
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-6 py-4">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {!loading && table.getRowModel().rows.length > 0 && (
          <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800 border-t">
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-700 dark:text-gray-300">
                Showing {table.getState().pagination.pageIndex * PAGE_SIZE + 1} to{' '}
                {Math.min(
                  (table.getState().pagination.pageIndex + 1) * PAGE_SIZE,
                  table.getFilteredRowModel().rows.length
                )}{' '}
                of {table.getFilteredRowModel().rows.length}
              </div>
              <Pagination
                total={table.getPageCount()}
                value={table.getState().pagination.pageIndex + 1}
                onChange={(page) => table.setPageIndex(page - 1)}
              >
                <PaginationFirst onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()} />
                <PaginationPrevious onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} />
                <PaginationItems />
                <PaginationNext onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} />
                <PaginationLast onClick={() => table.setPageIndex(table.getPageCount() - 1)} disabled={!table.getCanNextPage()} />
              </Pagination>
            </div>
          </div>
        )}
      </Card>

      {/* Add Events Modal */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => {
          setIsAddModalOpen(false);
          setSelectedEvents([]);
          setEventSearch('');
        }}
        title="Add Events to Calendar"
      >
        <div className="space-y-4">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-5 text-neutral-400" />
            <input
              type="text"
              placeholder="Search events by title or ID..."
              value={eventSearch}
              onChange={(e) => setEventSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>

          {searchingEvents ? (
            <div className="py-8 text-center">
              <LoadingSpinner size="small" />
            </div>
          ) : availableEvents.length > 0 ? (
            <div className="max-h-96 overflow-y-auto border rounded-lg divide-y">
              {availableEvents.map((event) => (
                <label
                  key={event.event_id}
                  className="flex items-center gap-3 p-3 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedEvents.includes(event.event_id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedEvents([...selectedEvents, event.event_id]);
                      } else {
                        setSelectedEvents(selectedEvents.filter(id => id !== event.event_id));
                      }
                    }}
                    className="rounded"
                  />
                  {event.event_logo && (
                    <img src={event.event_logo} alt="" className="w-10 h-10 rounded object-cover" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{event.event_title}</div>
                    <div className="text-xs text-gray-500">
                      {event.event_id} • {new Date(event.event_start).toLocaleDateString()}
                      {event.event_city && ` • ${event.event_city}`}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          ) : eventSearch.trim() ? (
            <div className="py-8 text-center text-gray-500">
              No events found
            </div>
          ) : (
            <div className="py-8 text-center text-gray-500">
              Search for events to add
            </div>
          )}

          <div className="flex justify-between items-center pt-4 border-t">
            <span className="text-sm text-gray-500">
              {selectedEvents.length} event(s) selected
            </span>
            <div className="flex gap-3">
              <Button
                variant="outlined"
                onClick={() => {
                  setIsAddModalOpen(false);
                  setSelectedEvents([]);
                  setEventSearch('');
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleAddEvents}
                disabled={selectedEvents.length === 0 || addingEvents}
              >
                {addingEvents ? 'Adding...' : `Add ${selectedEvents.length} Event(s)`}
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Remove Confirmation */}
      <ConfirmModal
        isOpen={!!removeEvent}
        onClose={() => setRemoveEvent(null)}
        onConfirm={handleRemoveEvent}
        title="Remove Event"
        message={`Are you sure you want to remove "${removeEvent?.event?.eventTitle}" from this calendar?`}
        confirmText="Remove"
        confirmVariant="danger"
      />
    </div>
  );
}
