import { useState, useEffect } from 'react';
import {
  CheckCircleIcon,
  XCircleIcon,
  ArrowPathIcon,
  EyeIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { Card, Button } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { getApiBaseUrl } from '@/config/brands';

interface Job {
  id: string;
  name: string;
  status: string;
  data: Record<string, unknown>;
  progress: number;
  attempts: number;
  maxAttempts: number;
  failedReason?: string;
  stacktrace?: string[];
  createdAt: number;
  processedOn?: number;
  finishedOn?: number;
  returnValue?: unknown;
}

export function JobsHistoryTab() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [filter, setFilter] = useState<'all' | 'completed' | 'failed'>('all');

  const apiUrl = getApiBaseUrl();

  useEffect(() => {
    fetchJobs();
  }, [filter]);

  const fetchJobs = async () => {
    setLoading(true);
    try {
      const status = filter === 'all' ? 'completed,failed' : filter;
      const res = await fetch(`${apiUrl}/api/jobs?status=${status}&end=100`);
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs || []);
      }
    } catch (error) {
      console.error('Error fetching jobs:', error);
    } finally {
      setLoading(false);
    }
  };

  const retryJob = async (jobId: string) => {
    try {
      const res = await fetch(`${apiUrl}/api/jobs/${jobId}/retry`, {
        method: 'POST',
      });
      if (res.ok) {
        await fetchJobs();
      } else {
        const error = await res.json();
        alert(`Failed to retry job: ${error.error}`);
      }
    } catch (error) {
      console.error('Error retrying job:', error);
    }
  };

  const removeJob = async (jobId: string) => {
    if (!confirm('Are you sure you want to remove this job?')) return;

    try {
      const res = await fetch(`${apiUrl}/api/jobs/${jobId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await fetchJobs();
        if (selectedJob?.id === jobId) {
          setSelectedJob(null);
        }
      }
    } catch (error) {
      console.error('Error removing job:', error);
    }
  };

  const cleanJobs = async (status: string) => {
    if (!confirm(`Are you sure you want to clean all ${status} jobs older than 24 hours?`)) return;

    try {
      const res = await fetch(`${apiUrl}/api/jobs/clean`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        const data = await res.json();
        alert(`Cleaned ${data.removed} jobs`);
        await fetchJobs();
      }
    } catch (error) {
      console.error('Error cleaning jobs:', error);
    }
  };

  const formatDuration = (start?: number, end?: number) => {
    if (!start || !end) return '-';
    const ms = end - start;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {(['all', 'completed', 'failed'] as const).map((f) => (
            <Button
              key={f}
              variant={filter === f ? 'soft' : 'ghost'}
              size="sm"
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            color="green"
            size="sm"
            onClick={() => cleanJobs('completed')}
          >
            Clean Completed
          </Button>
          <Button
            variant="outline"
            color="red"
            size="sm"
            onClick={() => cleanJobs('failed')}
          >
            Clean Failed
          </Button>
          <Button variant="outline" size="sm" onClick={fetchJobs}>
            <ArrowPathIcon className="size-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Job List */}
        <div>
          {loading ? (
            <Card className="p-8 flex justify-center">
              <LoadingSpinner />
            </Card>
          ) : jobs.length === 0 ? (
            <Card className="p-8 text-center text-[var(--gray-11)]">
              No jobs found
            </Card>
          ) : (
            <Card className="divide-y divide-[var(--gray-a5)] max-h-[600px] overflow-y-auto">
              {jobs.map((job) => (
                <div
                  key={job.id}
                  onClick={() => setSelectedJob(job)}
                  className={`p-3 cursor-pointer transition-colors ${
                    selectedJob?.id === job.id
                      ? 'bg-primary-50 dark:bg-primary-900/20'
                      : 'hover:bg-[var(--gray-a3)]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {job.status === 'completed' ? (
                      <CheckCircleIcon className="size-5 text-green-500 shrink-0 mt-0.5" />
                    ) : (
                      <XCircleIcon className="size-5 text-red-500 shrink-0 mt-0.5" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-[var(--gray-12)] text-sm truncate">
                        {job.name.replace(':', ' › ').replace(/_/g, ' ')}
                      </p>
                      <div className="flex items-center gap-3 mt-1 text-xs text-[var(--gray-11)]">
                        <span>{new Date(job.createdAt).toLocaleString()}</span>
                        <span>{formatDuration(job.processedOn, job.finishedOn)}</span>
                      </div>
                      {job.failedReason && (
                        <p className="text-xs text-red-500 dark:text-red-400 mt-1 truncate">
                          {job.failedReason}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </div>

        {/* Job Details */}
        <div>
          {selectedJob ? (
            <Card className="p-4">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-semibold text-[var(--gray-12)]">
                    {selectedJob.name.replace(':', ' › ').replace(/_/g, ' ')}
                  </h3>
                  <p className="text-xs text-[var(--gray-11)] mt-1">
                    ID: {selectedJob.id}
                  </p>
                </div>
                <div className="flex gap-2">
                  {selectedJob.status === 'failed' && (
                    <Button
                      variant="outline"
                      color="blue"
                      size="sm"
                      onClick={() => retryJob(selectedJob.id)}
                    >
                      <ArrowPathIcon className="size-4" />
                      Retry
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    color="red"
                    size="sm"
                    onClick={() => removeJob(selectedJob.id)}
                  >
                    <TrashIcon className="size-4" />
                  </Button>
                </div>
              </div>

              <div className="space-y-4">
                {/* Status */}
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <label className="text-xs text-[var(--gray-11)]">Status</label>
                    <p
                      className={`font-medium ${
                        selectedJob.status === 'completed'
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {selectedJob.status}
                    </p>
                  </div>
                  <div>
                    <label className="text-xs text-[var(--gray-11)]">Attempts</label>
                    <p className="font-medium text-[var(--gray-12)]">
                      {selectedJob.attempts}/{selectedJob.maxAttempts}
                    </p>
                  </div>
                  <div>
                    <label className="text-xs text-[var(--gray-11)]">Created</label>
                    <p className="text-[var(--gray-12)]">
                      {new Date(selectedJob.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <label className="text-xs text-[var(--gray-11)]">Duration</label>
                    <p className="text-[var(--gray-12)]">
                      {formatDuration(selectedJob.processedOn, selectedJob.finishedOn)}
                    </p>
                  </div>
                </div>

                {/* Error */}
                {selectedJob.failedReason && (
                  <div>
                    <label className="text-xs text-red-500 dark:text-red-400 block mb-1">
                      Error
                    </label>
                    <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                      <p className="text-sm text-red-700 dark:text-red-300">
                        {selectedJob.failedReason}
                      </p>
                      {selectedJob.stacktrace && selectedJob.stacktrace.length > 0 && (
                        <pre className="mt-2 text-xs text-red-600 dark:text-red-400 overflow-x-auto">
                          {selectedJob.stacktrace.join('\n')}
                        </pre>
                      )}
                    </div>
                  </div>
                )}

                {/* Job Data */}
                <div>
                  <label className="text-xs text-[var(--gray-11)] block mb-1">
                    Job Data
                  </label>
                  <pre className="bg-[var(--gray-a3)] rounded-lg p-3 text-xs overflow-x-auto">
                    {JSON.stringify(selectedJob.data, null, 2)}
                  </pre>
                </div>

                {/* Return Value */}
                {selectedJob.returnValue && (
                  <div>
                    <label className="text-xs text-[var(--gray-11)] block mb-1">
                      Result
                    </label>
                    <pre className="bg-[var(--gray-a3)] rounded-lg p-3 text-xs overflow-x-auto">
                      {JSON.stringify(selectedJob.returnValue, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </Card>
          ) : (
            <Card className="p-8 text-center text-[var(--gray-11)]">
              <EyeIcon className="size-12 mx-auto mb-3 opacity-50" />
              <p>Select a job to view details</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
