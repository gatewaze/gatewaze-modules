import { useState, useEffect } from 'react';
import {
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  ArrowPathIcon,
  PlayIcon,
  QueueListIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { Card, Button } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { getApiBaseUrl } from '@/config/brands';

interface JobCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

interface Job {
  id: string;
  name: string;
  status: string;
  data: Record<string, unknown>;
  progress: number;
  attempts: number;
  maxAttempts: number;
  failedReason?: string;
  createdAt: number;
  processedOn?: number;
  finishedOn?: number;
}

interface JobType {
  key: string;
  value: string;
  category: string;
}

export function JobsOverviewTab() {
  const [counts, setCounts] = useState<JobCounts | null>(null);
  const [activeJobs, setActiveJobs] = useState<Job[]>([]);
  const [jobTypes, setJobTypes] = useState<JobType[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [selectedJobType, setSelectedJobType] = useState('');

  const apiUrl = getApiBaseUrl();

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000); // Refresh every 5 seconds
    return () => clearInterval(interval);
  }, []);

  const fetchData = async () => {
    try {
      const [countsRes, jobsRes, typesRes] = await Promise.all([
        fetch(`${apiUrl}/api/jobs/counts`),
        fetch(`${apiUrl}/api/jobs?status=waiting,active,delayed`),
        fetch(`${apiUrl}/api/jobs/types`),
      ]);

      if (countsRes.ok) {
        const data = await countsRes.json();
        setCounts(data.counts);
      }

      if (jobsRes.ok) {
        const data = await jobsRes.json();
        setActiveJobs(data.jobs || []);
      }

      if (typesRes.ok) {
        const data = await typesRes.json();
        setJobTypes(data.types || []);
      }
    } catch (error) {
      console.error('Error fetching job data:', error);
    } finally {
      setLoading(false);
    }
  };

  const createJob = async () => {
    if (!selectedJobType) return;

    setCreating(true);
    try {
      const res = await fetch(`${apiUrl}/api/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: selectedJobType }),
      });

      if (res.ok) {
        await fetchData();
        setSelectedJobType('');
      } else {
        const error = await res.json();
        alert(`Failed to create job: ${error.error}`);
      }
    } catch (error) {
      console.error('Error creating job:', error);
    } finally {
      setCreating(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
        return 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20';
      case 'waiting':
        return 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20';
      case 'delayed':
        return 'text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20';
      case 'completed':
        return 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20';
      case 'failed':
        return 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20';
      default:
        return 'text-[var(--gray-11)] bg-gray-50 dark:bg-gray-900/20';
    }
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
      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-900/20">
              <ClockIcon className="size-5 text-amber-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[var(--gray-12)]">
                {counts?.waiting || 0}
              </p>
              <p className="text-xs text-[var(--gray-11)]">Waiting</p>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-900/20">
              <PlayIcon className="size-5 text-blue-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[var(--gray-12)]">
                {counts?.active || 0}
              </p>
              <p className="text-xs text-[var(--gray-11)]">Active</p>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-50 dark:bg-purple-900/20">
              <QueueListIcon className="size-5 text-purple-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[var(--gray-12)]">
                {counts?.delayed || 0}
              </p>
              <p className="text-xs text-[var(--gray-11)]">Delayed</p>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-50 dark:bg-green-900/20">
              <CheckCircleIcon className="size-5 text-green-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[var(--gray-12)]">
                {counts?.completed || 0}
              </p>
              <p className="text-xs text-[var(--gray-11)]">Completed</p>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-red-50 dark:bg-red-900/20">
              <XCircleIcon className="size-5 text-red-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[var(--gray-12)]">
                {counts?.failed || 0}
              </p>
              <p className="text-xs text-[var(--gray-11)]">Failed</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Create Job */}
      <Card className="p-4">
        <h3 className="text-sm font-medium text-[var(--gray-12)] mb-3">
          Create New Job
        </h3>
        <div className="flex gap-3">
          <select
            value={selectedJobType}
            onChange={(e) => setSelectedJobType(e.target.value)}
            className="flex-1 rounded-lg border border-[var(--gray-a5)] bg-[var(--color-background)] px-3 py-2 text-sm"
          >
            <option value="">Select job type...</option>
            {jobTypes.map((type) => (
              <option key={type.value} value={type.value}>
                {type.category}: {type.key.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <Button
            onClick={createJob}
            disabled={!selectedJobType || creating}
            className="flex items-center gap-2"
          >
            {creating ? <LoadingSpinner className="size-4" /> : <PlayIcon className="size-4" />}
            Run Job
          </Button>
        </div>
      </Card>

      {/* Active Jobs */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-[var(--gray-12)]">
            Queue ({activeJobs.length})
          </h3>
          <Button
            variant="outlined"
            size="sm"
            onClick={fetchData}
            className="flex items-center gap-1"
          >
            <ArrowPathIcon className="size-4" />
            Refresh
          </Button>
        </div>

        {activeJobs.length === 0 ? (
          <Card className="p-8 text-center text-[var(--gray-11)]">
            <QueueListIcon className="size-12 mx-auto mb-3 opacity-50" />
            <p>No jobs in queue</p>
          </Card>
        ) : (
          <Card className="divide-y divide-[var(--gray-a5)]">
            {activeJobs.map((job) => (
              <div key={job.id} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-[var(--gray-12)]">
                        {job.name.replace(':', ' › ').replace(/_/g, ' ')}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${getStatusColor(
                          job.status
                        )}`}
                      >
                        {job.status}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--gray-11)] mt-1">
                      ID: {job.id}
                    </p>
                    {job.status === 'active' && job.progress > 0 && (
                      <div className="mt-2">
                        <div className="flex items-center justify-between text-xs text-[var(--gray-11)] mb-1">
                          <span>Progress</span>
                          <span>{job.progress}%</span>
                        </div>
                        <div className="h-1.5 bg-[var(--gray-a3)] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full transition-all"
                            style={{ width: `${job.progress}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="text-right text-xs text-[var(--gray-11)]">
                    <p>Attempt {job.attempts}/{job.maxAttempts}</p>
                    <p>{new Date(job.createdAt).toLocaleTimeString()}</p>
                  </div>
                </div>
              </div>
            ))}
          </Card>
        )}
      </div>

      {/* Warning if no Redis */}
      {!apiUrl && (
        <Card className="p-4 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800">
          <div className="flex items-start gap-3">
            <ExclamationTriangleIcon className="size-5 text-amber-500 shrink-0 mt-0.5" />
            <div className="text-sm text-amber-800 dark:text-amber-200">
              <p className="font-medium">API URL not configured</p>
              <p className="mt-1 text-amber-600 dark:text-amber-300">
                Set VITE_API_BASE_URL to connect to the job queue API.
              </p>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
