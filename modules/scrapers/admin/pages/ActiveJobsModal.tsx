import { useState, useEffect, useRef } from 'react';
import { Modal, Button } from '@/components/ui';
import { ScraperService } from '@/utils/scraperService';
import { ScrapingModal } from './ScrapingModal';
import { StopIcon } from '@heroicons/react/24/outline';

interface ActiveJobsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ActiveJob {
  jobId: number;
  status: string;
  startedAt: string;
  scraperName: string;
  eventType: string;
  stats: any;
  hasActiveClients: boolean;
}

export function ActiveJobsModal({ isOpen, onClose }: ActiveJobsModalProps) {
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [showScrapingModal, setShowScrapingModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadActiveJobs();
      intervalRef.current = setInterval(() => {
        loadActiveJobs();
      }, 5000);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isOpen]);

  const loadActiveJobs = async () => {
    try {
      setError(null);
      const result = await ScraperService.getActiveJobs();
      if (result.data && Array.isArray(result.data)) {
        setActiveJobs(result.data);
      } else if (result.error) {
        setError(result.error);
        setActiveJobs([]);
      } else {
        setActiveJobs([]);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unknown error occurred');
      setActiveJobs([]);
    } finally {
      setLoading(false);
    }
  };

  const handleStopJob = async (jobId: number) => {
    if (!confirm('Are you sure you want to stop this scraper job?')) return;
    const result = await ScraperService.stopJob(jobId);
    if (result.success) {
      await loadActiveJobs();
    } else {
      alert(`Failed to stop job: ${result.error || 'Unknown error'}`);
    }
  };

  const handleConnectToJob = (jobId: number) => {
    setSelectedJobId(jobId);
    setShowScrapingModal(true);
  };

  const handleScrapingModalClose = () => {
    setShowScrapingModal(false);
    setSelectedJobId(null);
    loadActiveJobs();
  };

  const formatDuration = (startedAt: string) => {
    if (!startedAt) return 'Unknown';
    const diff = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
    if (diff < 0) return '0s';
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
    return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running': return 'text-green-600 bg-green-100';
      case 'processing': return 'text-blue-600 bg-blue-100';
      case 'completed': return 'text-gray-600 bg-gray-100';
      case 'failed': return 'text-red-600 bg-red-100';
      case 'cancelled': return 'text-yellow-600 bg-yellow-100';
      default: return 'text-gray-600 bg-gray-100';
    }
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Active Scraper Jobs"
        size="xl"
        footer={
          <div className="flex items-center justify-between">
            <div className="text-sm text-[var(--gray-9)]">
              Jobs will automatically clean up 5 minutes after completion
            </div>
            <Button variant="outline" onClick={onClose}>Close</Button>
          </div>
        }
      >
        <p className="text-sm text-[var(--gray-9)] mb-4">
          {activeJobs.length} job{activeJobs.length !== 1 ? 's' : ''} currently running
        </p>

        {loading ? (
          <div className="py-8 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)] mx-auto" />
            <p className="mt-2 text-sm text-[var(--gray-9)]">Loading active jobs...</p>
          </div>
        ) : error ? (
          <div className="py-8 text-center">
            <p className="text-red-500 mb-2">Error loading active jobs: {error}</p>
            <Button variant="solid" onClick={loadActiveJobs}>Retry</Button>
          </div>
        ) : activeJobs.length === 0 ? (
          <div className="py-8 text-center text-[var(--gray-9)]">No active jobs running</div>
        ) : (
          <div className="divide-y divide-[var(--gray-a6)]">
            {activeJobs.filter(job => job && typeof job.jobId === 'number').map((job) => (
              <div key={job.jobId} className="py-4 first:pt-0 last:pb-0">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[var(--gray-12)]">{job.scraperName || 'Unknown'}</span>
                      <span className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-full ${getStatusColor(job.status || 'unknown')}`}>
                        {job.status || 'unknown'}
                      </span>
                      <span className="text-xs text-[var(--gray-9)]">#{job.jobId}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-[var(--gray-9)]">
                      <span>Type: {job.eventType || 'unknown'}</span>
                      <span>Duration: {formatDuration(job.startedAt || '')}</span>
                      {job.stats?.processed != null && <span>Processed: {job.stats.processed}</span>}
                      {job.hasActiveClients && <span className="text-green-600 font-medium">Connected</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={() => handleConnectToJob(job.jobId)}>
                      {job.hasActiveClients ? 'View Logs' : 'Connect'}
                    </Button>
                    {(job.status === 'running' || job.status === 'processing') && (
                      <Button variant="outline" color="red" onClick={() => handleStopJob(job.jobId)}>
                        <StopIcon className="h-4 w-4 mr-1" /> Stop
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {showScrapingModal && selectedJobId && (
        <ScrapingModal
          isOpen={showScrapingModal}
          onClose={handleScrapingModalClose}
          jobIds={[selectedJobId]}
          reconnectMode={true}
        />
      )}
    </>
  );
}
