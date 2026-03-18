import { useState, useEffect, useRef } from 'react';
import { Dialog } from '@headlessui/react';
import { XMarkIcon, StopIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui';
import { ScraperService } from '@/utils/scraperService';
import { ScrapingModal } from './ScrapingModal';

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
    try {
      if (isOpen) {
        loadActiveJobs();
        // Refresh every 5 seconds
        intervalRef.current = setInterval(() => {
          try {
            loadActiveJobs();
          } catch (error) {
            console.error('Error in interval loadActiveJobs:', error);
          }
        }, 5000);
      }

      return () => {
        try {
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
        } catch (error) {
          console.error('Error clearing interval:', error);
        }
      };
    } catch (error) {
      console.error('Error in useEffect:', error);
    }
  }, [isOpen]);

  const loadActiveJobs = async () => {
    try {
      setError(null);
      const result = await ScraperService.getActiveJobs();
      if (result.data && Array.isArray(result.data)) {
        setActiveJobs(result.data);
      } else if (result.error) {
        console.error('Error loading active jobs:', result.error);
        setError(result.error);
        setActiveJobs([]);
      } else {
        setActiveJobs([]);
      }
    } catch (error) {
      console.error('Error loading active jobs:', error);
      setError(error instanceof Error ? error.message : 'Unknown error occurred');
      setActiveJobs([]);
    } finally {
      setLoading(false);
    }
  };

  const handleStopJob = async (jobId: number) => {
    try {
      if (typeof jobId !== 'number' || jobId <= 0) {
        console.error('Invalid jobId for stop:', jobId);
        return;
      }

      if (!confirm('Are you sure you want to stop this scraper job?')) {
        return;
      }

      const result = await ScraperService.stopJob(jobId);
      if (result.success) {
        await loadActiveJobs(); // Refresh the list
      } else {
        alert(`Failed to stop job: ${result.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Error stopping job:', error);
      alert('Failed to stop job');
    }
  };

  const handleConnectToJob = (jobId: number) => {
    try {
      if (typeof jobId !== 'number' || jobId <= 0) {
        console.error('Invalid jobId:', jobId);
        return;
      }
      setSelectedJobId(jobId);
      setShowScrapingModal(true);
    } catch (error) {
      console.error('Error connecting to job:', error);
    }
  };

  const handleScrapingModalClose = () => {
    try {
      setShowScrapingModal(false);
      setSelectedJobId(null);
      loadActiveJobs(); // Refresh active jobs
    } catch (error) {
      console.error('Error closing scraping modal:', error);
    }
  };

  const formatDuration = (startedAt: string) => {
    try {
      if (!startedAt) return 'Unknown';

      const start = new Date(startedAt).getTime();
      const now = new Date().getTime();

      if (isNaN(start) || isNaN(now)) return 'Invalid date';

      const diff = Math.floor((now - start) / 1000);

      if (diff < 0) return '0s';
      if (diff < 60) return `${diff}s`;
      if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
      return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
    } catch (error) {
      console.error('Error formatting duration:', error);
      return 'Unknown';
    }
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

  // Safe render with error boundary
  const renderModal = () => {
    try {
      return (
        <Dialog open={isOpen} onClose={onClose} className="relative z-50">
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" aria-hidden="true" />

        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="mx-auto max-w-5xl w-full bg-white rounded-lg shadow-xl">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div>
                <Dialog.Title className="text-lg font-medium text-gray-900">
                  Active Scraper Jobs
                </Dialog.Title>
                <p className="mt-1 text-sm text-gray-500">
                  {activeJobs.length} job{activeJobs.length !== 1 ? 's' : ''} currently running
                </p>
              </div>

              <Button isIcon variant="ghost" onClick={onClose}>
                <XMarkIcon className="h-6 w-6" />
              </Button>
            </div>

            <div className="max-h-96 overflow-y-auto">
              {loading ? (
                <div className="p-6 text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                  <p className="mt-2 text-sm text-gray-500">Loading active jobs...</p>
                </div>
              ) : error ? (
                <div className="p-6 text-center">
                  <p className="text-red-500">Error loading active jobs: {error}</p>
                  <Button variant="solid" onClick={loadActiveJobs}>
                    Retry
                  </Button>
                </div>
              ) : !activeJobs || activeJobs.length === 0 ? (
                <div className="p-6 text-center">
                  <p className="text-gray-500">No active jobs running</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-200">
                  {activeJobs.filter(job => job && typeof job.jobId === 'number').map((job) => {
                    try {
                      return (
                        <div key={job.jobId} className="p-6 hover:bg-gray-50">
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <div className="flex items-center space-x-3">
                                <h3 className="text-sm font-medium text-gray-900">
                                  {job.scraperName || 'Unknown'}
                                </h3>
                                <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getStatusColor(job.status || 'unknown')}`}>
                                  {job.status || 'unknown'}
                                </span>
                                <span className="text-xs text-gray-500">
                                  #{job.jobId}
                                </span>
                              </div>

                              <div className="mt-1 flex items-center space-x-4 text-xs text-gray-500">
                                <span>Type: {job.eventType || 'unknown'}</span>
                                <span>Duration: {formatDuration(job.startedAt || '')}</span>
                                {job.stats && typeof job.stats.processed === 'number' && (
                                  <span>Processed: {job.stats.processed}</span>
                                )}
                                {job.hasActiveClients && (
                                  <span className="text-green-600 font-medium">● Connected</span>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center space-x-2">
                              <Button
                                variant="outline"
                                onClick={() => handleConnectToJob(job.jobId)}
                              >
                                {job.hasActiveClients ? 'View Logs' : 'Connect'}
                              </Button>

                              {(job.status === 'running' || job.status === 'processing') && (
                                <Button
                                  variant="outline"
                                  color="red"
                                  onClick={() => handleStopJob(job.jobId)}
                                >
                                  <StopIcon className="h-4 w-4 mr-1" />
                                  Stop
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    } catch (error) {
                      console.error('Error rendering job:', job, error);
                      return null;
                    }
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between p-6 border-t border-gray-200 bg-gray-50">
              <div className="text-sm text-gray-600">
                Jobs will automatically clean up 5 minutes after completion
              </div>

              <Button variant="solid" color="gray" onClick={onClose}>
                Close
              </Button>
            </div>
          </Dialog.Panel>
        </div>
      </Dialog>
      );
    } catch (error) {
      console.error('Error rendering ActiveJobsModal:', error);
      return (
        <Dialog open={isOpen} onClose={onClose} className="relative z-50">
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" aria-hidden="true" />
          <div className="fixed inset-0 flex items-center justify-center p-4">
            <div className="mx-auto max-w-md w-full bg-white rounded-lg shadow-xl p-6">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Error Loading Active Jobs</h3>
              <p className="text-sm text-red-600 mb-4">
                There was an error loading the active jobs modal. Please try again.
              </p>
              <Button variant="solid" color="gray" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        </Dialog>
      );
    }
  };

  return (
    <>
      {renderModal()}

      {/* Scraping Modal for selected job */}
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