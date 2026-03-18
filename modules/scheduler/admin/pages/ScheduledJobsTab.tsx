import { useState, useEffect } from 'react';
import {
  ClockIcon,
  ArrowPathIcon,
  TrashIcon,
  CalendarDaysIcon,
} from '@heroicons/react/24/outline';
import { Card, Button } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { getApiBaseUrl } from '@/config/brands';

interface ScheduledJob {
  key: string;
  name: string;
  id: string;
  endDate: number | null;
  tz: string | null;
  pattern: string;
  next: number;
}

export function ScheduledJobsTab() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(true);

  const apiUrl = getApiBaseUrl();

  useEffect(() => {
    fetchJobs();
  }, []);

  const fetchJobs = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/jobs/scheduled`);
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs || []);
      }
    } catch (error) {
      console.error('Error fetching scheduled jobs:', error);
    } finally {
      setLoading(false);
    }
  };

  const removeJob = async (key: string) => {
    if (!confirm('Are you sure you want to remove this scheduled job?')) return;

    try {
      const res = await fetch(`${apiUrl}/api/jobs/scheduled/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await fetchJobs();
      } else {
        const error = await res.json();
        alert(`Failed to remove job: ${error.error}`);
      }
    } catch (error) {
      console.error('Error removing job:', error);
    }
  };

  const formatCron = (pattern: string) => {
    // Simple cron pattern descriptions
    const descriptions: Record<string, string> = {
      '* * * * *': 'Every minute',
      '*/5 * * * *': 'Every 5 minutes',
      '*/15 * * * *': 'Every 15 minutes',
      '*/30 * * * *': 'Every 30 minutes',
      '0 * * * *': 'Every hour',
      '0 */2 * * *': 'Every 2 hours',
      '0 */3 * * *': 'Every 3 hours',
      '0 */6 * * *': 'Every 6 hours',
      '0 */12 * * *': 'Every 12 hours',
      '0 0 * * *': 'Daily at midnight',
      '0 6 * * *': 'Daily at 6 AM',
      '0 0 * * 0': 'Weekly on Sunday',
      '0 0 1 * *': 'Monthly on the 1st',
    };

    return descriptions[pattern] || pattern;
  };

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
            Scheduled Jobs
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Jobs that run automatically on a schedule
          </p>
        </div>
        <Button variant="outlined" size="sm" onClick={fetchJobs}>
          <ArrowPathIcon className="size-4" />
          Refresh
        </Button>
      </div>

      {/* Info */}
      <Card className="p-4 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800">
        <div className="flex items-start gap-3">
          <CalendarDaysIcon className="size-5 text-blue-500 shrink-0 mt-0.5" />
          <div className="text-sm text-blue-800 dark:text-blue-200">
            <p className="font-medium">About Scheduled Jobs</p>
            <p className="mt-1 text-blue-600 dark:text-blue-300">
              Scheduled jobs are created by the scheduler service based on scraper configurations.
              They automatically enqueue jobs at the specified intervals.
            </p>
          </div>
        </div>
      </Card>

      {/* Jobs List */}
      {jobs.length === 0 ? (
        <Card className="p-8 text-center text-gray-500 dark:text-gray-400">
          <ClockIcon className="size-12 mx-auto mb-3 opacity-50" />
          <p>No scheduled jobs</p>
          <p className="text-xs mt-1">
            Jobs are scheduled when scrapers are configured with a schedule
          </p>
        </Card>
      ) : (
        <div className="grid gap-4">
          {jobs.map((job) => (
            <Card key={job.key} className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-purple-50 dark:bg-purple-900/20">
                    <ClockIcon className="size-5 text-purple-500" />
                  </div>
                  <div>
                    <h3 className="font-medium text-gray-900 dark:text-white">
                      {job.name.replace(':', ' › ').replace(/_/g, ' ')}
                    </h3>
                    <div className="flex items-center gap-4 mt-1 text-sm text-gray-500 dark:text-gray-400">
                      <span className="flex items-center gap-1">
                        <ClockIcon className="size-3" />
                        {formatCron(job.pattern)}
                      </span>
                      {job.tz && <span>TZ: {job.tz}</span>}
                    </div>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                      Next run: {new Date(job.next).toLocaleString()}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outlined"
                  size="sm"
                  onClick={() => removeJob(job.key)}
                  className="text-red-600 dark:text-red-400"
                >
                  <TrashIcon className="size-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
