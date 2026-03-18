import { useState, useEffect } from 'react';
import {
  ClockIcon,
  ArrowPathIcon,
  PlayIcon,
  CalendarDaysIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline';
import { Card, Button, Badge } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Link } from 'react-router-dom';
import { getApiBaseUrl } from '@/config/brands';

interface ScraperSchedule {
  id: number;
  name: string;
  description: string;
  scraperType: string;
  eventType: string;
  scheduleEnabled: boolean;
  scheduleFrequency: string;
  scheduleTime: string | null;
  scheduleDays: number[] | null;
  scheduleCron: string | null;
  nextScheduledRun: string | null;
  createdAt: string;
  updatedAt: string;
}

const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ScraperSchedulesTab() {
  const [schedules, setSchedules] = useState<ScraperSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningScrapers, setRunningScrapers] = useState<Set<number>>(new Set());

  const apiUrl = getApiBaseUrl();

  useEffect(() => {
    fetchSchedules();
  }, []);

  const fetchSchedules = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/jobs/scraper-schedules`);
      if (res.ok) {
        const data = await res.json();
        setSchedules(data.schedules || []);
      }
    } catch (error) {
      console.error('Error fetching scraper schedules:', error);
    } finally {
      setLoading(false);
    }
  };

  const runScraper = async (scraperId: number, scraperName: string) => {
    if (runningScrapers.has(scraperId)) return;

    setRunningScrapers((prev) => new Set([...prev, scraperId]));

    try {
      const res = await fetch(`${apiUrl}/api/jobs/scraper-schedules/${scraperId}/run`, {
        method: 'POST',
      });

      if (res.ok) {
        // Refresh schedules to show updated status
        await fetchSchedules();
      } else {
        const error = await res.json();
        alert(`Failed to run scraper: ${error.error}`);
      }
    } catch (error) {
      console.error('Error running scraper:', error);
      alert('Failed to run scraper');
    } finally {
      setRunningScrapers((prev) => {
        const next = new Set(prev);
        next.delete(scraperId);
        return next;
      });
    }
  };

  const formatFrequency = (schedule: ScraperSchedule) => {
    if (!schedule.scheduleEnabled) return 'Disabled';

    const frequency = schedule.scheduleFrequency;

    switch (frequency) {
      case '5min':
        return 'Every 5 minutes';
      case 'hourly':
        return 'Every hour';
      case 'daily':
        return schedule.scheduleTime
          ? `Daily at ${schedule.scheduleTime.slice(0, 5)}`
          : 'Daily';
      case 'weekly':
        const days =
          schedule.scheduleDays?.map((d) => dayNames[d]).join(', ') || '';
        return schedule.scheduleTime
          ? `Weekly on ${days} at ${schedule.scheduleTime.slice(0, 5)}`
          : `Weekly on ${days}`;
      case 'custom':
        return schedule.scheduleCron || 'Custom';
      default:
        return frequency || 'Not set';
    }
  };

  const enabledSchedules = schedules.filter((s) => s.scheduleEnabled);
  const disabledSchedules = schedules.filter((s) => !s.scheduleEnabled);

  if (loading) {
    return (
      <Card className="p-8 flex justify-center">
        <LoadingSpinner />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Scraper Schedules
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Database-configured scraper schedules ({enabledSchedules.length} active)
          </p>
        </div>
        <Button variant="outlined" size="sm" onClick={fetchSchedules}>
          <ArrowPathIcon className="size-4" />
          Refresh
        </Button>
      </div>

      {/* Info */}
      <Card className="p-4 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800">
        <div className="flex items-start gap-3">
          <CalendarDaysIcon className="size-5 text-amber-500 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800 dark:text-amber-200">
            <p className="font-medium">About Scraper Schedules</p>
            <p className="mt-1 text-amber-600 dark:text-amber-300">
              These schedules are configured in the scrapers database table. The scheduler
              service polls for due scrapers every minute and enqueues them as BullMQ jobs.
              Edit schedules in the{' '}
              <Link to="/admin/scrapers" className="underline hover:no-underline">
                Scrapers page
              </Link>
              .
            </p>
          </div>
        </div>
      </Card>

      {/* Active Schedules */}
      {enabledSchedules.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Active Schedules ({enabledSchedules.length})
          </h3>
          <div className="grid gap-4">
            {enabledSchedules.map((schedule) => (
              <Card key={schedule.id} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className="p-2 rounded-lg bg-green-50 dark:bg-green-900/20 shrink-0">
                      <ClockIcon className="size-5 text-green-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium text-gray-900 dark:text-white truncate">
                          {schedule.name}
                        </h3>
                        <Badge variant="primary" size="sm">
                          {schedule.eventType}
                        </Badge>
                      </div>
                      {schedule.description && (
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                          {schedule.description}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-gray-500 dark:text-gray-400">
                        <span className="flex items-center gap-1">
                          <ClockIcon className="size-3" />
                          {formatFrequency(schedule)}
                        </span>
                        {schedule.nextScheduledRun && (
                          <span>
                            Next: {new Date(schedule.nextScheduledRun).toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Link to={`/admin/scrapers?edit=${schedule.id}`}>
                      <Button variant="outlined" size="sm" title="Edit scraper">
                        <Cog6ToothIcon className="size-4" />
                      </Button>
                    </Link>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => runScraper(schedule.id, schedule.name)}
                      disabled={runningScrapers.has(schedule.id)}
                      title="Run now"
                    >
                      {runningScrapers.has(schedule.id) ? (
                        <ArrowPathIcon className="size-4 animate-spin" />
                      ) : (
                        <PlayIcon className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Disabled Schedules */}
      {disabledSchedules.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">
            Disabled Schedules ({disabledSchedules.length})
          </h3>
          <div className="grid gap-3">
            {disabledSchedules.map((schedule) => (
              <Card
                key={schedule.id}
                className="p-3 opacity-60 hover:opacity-100 transition-opacity"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="p-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 shrink-0">
                      <ClockIcon className="size-4 text-gray-400" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-700 dark:text-gray-300 truncate">
                          {schedule.name}
                        </span>
                        <Badge variant="default" size="sm">
                          {schedule.eventType}
                        </Badge>
                      </div>
                      <p className="text-xs text-gray-400 dark:text-gray-500">
                        Schedule disabled
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Link to={`/admin/scrapers?edit=${schedule.id}`}>
                      <Button variant="outlined" size="sm" title="Edit scraper">
                        <Cog6ToothIcon className="size-4" />
                      </Button>
                    </Link>
                    <Button
                      variant="outlined"
                      size="sm"
                      onClick={() => runScraper(schedule.id, schedule.name)}
                      disabled={runningScrapers.has(schedule.id)}
                      title="Run now"
                    >
                      {runningScrapers.has(schedule.id) ? (
                        <ArrowPathIcon className="size-4 animate-spin" />
                      ) : (
                        <PlayIcon className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {schedules.length === 0 && (
        <Card className="p-8 text-center text-gray-500 dark:text-gray-400">
          <ClockIcon className="size-12 mx-auto mb-3 opacity-50" />
          <p>No scrapers configured</p>
          <p className="text-xs mt-1">
            <Link to="/admin/scrapers" className="text-primary-500 hover:underline">
              Create scrapers
            </Link>{' '}
            with schedules to see them here
          </p>
        </Card>
      )}
    </div>
  );
}
