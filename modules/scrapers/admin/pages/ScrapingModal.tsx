import { useState, useEffect, useRef } from 'react';
import { Dialog } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui';
import { getApiBaseUrl } from '@/config/brands';

interface ScrapingModalProps {
  isOpen: boolean;
  onClose: () => void;
  jobIds: number[];
  reconnectMode?: boolean;
}

interface LogEntry {
  type: 'log' | 'progress' | 'complete' | 'error' | 'connected' | 'cancelled';
  message?: string;
  stats?: any;
  error?: string;
  timestamp: string;
  metadata?: any;
  level?: string;
}

export function ScrapingModal({ isOpen, onClose, jobIds, reconnectMode = false }: ScrapingModalProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [isComplete, setIsComplete] = useState(false);
  const [completedJobs, setCompletedJobs] = useState(0);
  const [totalJobs, setTotalJobs] = useState(jobIds.length);
  const [hasError, setHasError] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const eventSourcesRef = useRef<EventSource[]>([]);

  // Track if we've already started jobs for these jobIds
  const startedJobsRef = useRef<Set<number>>(new Set());

  // Store the previous jobIds to detect actual changes
  const prevJobIdsRef = useRef<string>('');

  useEffect(() => {
    if (isOpen && jobIds.length > 0) {
      // Create a stable key for the current jobIds
      const currentJobIdsKey = [...jobIds].sort((a, b) => a - b).join(',');
      const hasJobIdsChanged = currentJobIdsKey !== prevJobIdsRef.current;

      // Only proceed if this is truly a new set of jobs
      if (hasJobIdsChanged) {
        prevJobIdsRef.current = currentJobIdsKey;

        if (reconnectMode) {
          // Reconnecting to running job - load historical logs AND connect to live stream
          setLogs([]);
          setIsComplete(false);
          setCompletedJobs(0);
          setTotalJobs(jobIds.length);
          setHasError(false);

          addLog(`📜 Loading historical logs for job ${jobIds[0]}...`);
          loadHistoricalLogsAndConnect();
        } else {
          // Starting new jobs
          setLogs([]);
          setIsComplete(false);
          setCompletedJobs(0);
          setTotalJobs(jobIds.length);
          setHasError(false);

          // Add initial log
          addLog(`🚀 Starting scraping jobs for ${jobIds.length} scraper${jobIds.length > 1 ? 's' : ''}...`);

          // Mark these jobs as started
          jobIds.forEach(id => startedJobsRef.current.add(id));

          // Start jobs and connect to their streams
          startJobs();
        }
      }
    }

    // Cleanup when modal closes
    if (!isOpen) {
      cleanup();
      // Reset the prev key when modal closes completely
      if (isComplete) {
        prevJobIdsRef.current = '';
        // Clear logs on complete close
        setLogs([]);
      }
    }

    return () => {
      // Cleanup EventSources on unmount or when closing
      if (!isOpen) {
        cleanup();
      }
    };
  }, [isOpen, jobIds, isComplete]);


  useEffect(() => {
    scrollToBottom();
  }, [logs]);

  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, `[${timestamp}] ${message}`]);
  };

  const scrollToBottom = () => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const cleanup = () => {
    // Close all EventSource connections
    eventSourcesRef.current.forEach(es => {
      es.close();
    });
    eventSourcesRef.current = [];

    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
  };

  const fetchHistoricalLogs = async (jobId: number): Promise<LogEntry[]> => {
    const apiBase = getApiBaseUrl();
    try {
      const response = await fetch(`${apiBase}/scrapers/${jobId}/logs`);
      if (!response.ok) {
        console.error(`Failed to fetch historical logs for job ${jobId}`);
        return [];
      }
      const logs = await response.json();
      return logs;
    } catch (error) {
      console.error(`Error fetching historical logs for job ${jobId}:`, error);
      return [];
    }
  };

  const loadHistoricalLogsOnly = async () => {
    // Fetch historical logs for all jobs (for viewing completed jobs)
    const allHistoricalLogs: LogEntry[] = [];

    for (const jobId of jobIds) {
      const historicalLogs = await fetchHistoricalLogs(jobId);
      allHistoricalLogs.push(...historicalLogs);
    }

    // Sort logs by timestamp
    allHistoricalLogs.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    // Add historical logs to the UI
    if (allHistoricalLogs.length > 0) {
      addLog(`✅ Loaded ${allHistoricalLogs.length} historical log entries`);

      // Process each historical log entry
      for (const log of allHistoricalLogs) {
        switch (log.type) {
          case 'log':
            if (log.message) {
              // Extract message without timestamp prefix (already in message)
              setLogs(prev => [...prev, log.message as string]);
            }
            break;
          case 'progress':
            if (log.metadata) {
              addLog(`📊 Progress: ${log.metadata.processed || 0} processed, ${log.metadata.failed || 0} failed`);
            }
            break;
          case 'error':
            if (log.message) {
              addLog(`❌ Error: ${log.message}`);
            }
            break;
          case 'complete':
            if (log.message) {
              addLog(`✅ ${log.message}`);
            }
            break;
        }
      }

      // Mark as complete since we've loaded all historical logs
      setIsComplete(true);
      setCompletedJobs(jobIds.length);
    } else {
      addLog(`ℹ️  No historical logs found in database`);
      addLog(`⚠️  Note: Logs are only stored if the scraper_job_logs table exists`);
      setIsComplete(true);
    }
  };

  const loadHistoricalLogsAndConnect = async () => {
    // Fetch historical logs for all jobs (for reconnecting to running jobs)
    const allHistoricalLogs: LogEntry[] = [];

    for (const jobId of jobIds) {
      const historicalLogs = await fetchHistoricalLogs(jobId);
      allHistoricalLogs.push(...historicalLogs);
    }

    // Sort logs by timestamp
    allHistoricalLogs.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    // Add historical logs to the UI
    if (allHistoricalLogs.length > 0) {
      addLog(`📜 Loaded ${allHistoricalLogs.length} historical log entries`);

      // Process each historical log entry
      for (const log of allHistoricalLogs) {
        switch (log.type) {
          case 'log':
            if (log.message) {
              // Extract message without timestamp prefix (already in message)
              setLogs(prev => [...prev, log.message as string]);
            }
            break;
          case 'progress':
            if (log.metadata) {
              addLog(`📊 Progress: ${log.metadata.processed || 0} processed, ${log.metadata.failed || 0} failed`);
            }
            break;
          case 'error':
            if (log.message) {
              addLog(`❌ Error: ${log.message}`);
            }
            break;
          case 'complete':
            if (log.message) {
              addLog(`✅ ${log.message}`);
            }
            break;
        }
      }

      addLog(`📡 Connecting to live stream...`);
    } else {
      addLog(`ℹ️  No historical logs found, connecting to live stream...`);
    }

    // Now connect to the live streams
    connectToStreams();
  };

  const connectToStreams = () => {
    const apiBase = getApiBaseUrl();
    let completedCount = 0;

    for (const jobId of jobIds) {
      // Connect to the job's log stream
      const eventSource = new EventSource(`${apiBase}/scrapers/${jobId}/stream`);
      eventSourcesRef.current.push(eventSource);

      eventSource.onmessage = (event) => {
        try {
          const data: LogEntry = JSON.parse(event.data);

          switch (data.type) {
            case 'log':
              if (data.message) {
                addLog(data.message);
              }
              break;

            case 'progress':
              if (data.stats) {
                addLog(`📊 Progress: ${data.stats.processed} processed, ${data.stats.failed} failed`);
              }
              break;

            case 'complete':
              completedCount++;
              setCompletedJobs(completedCount);
              addLog(`✅ Job ${jobId} completed successfully!`);

              if (completedCount === jobIds.length) {
                setIsComplete(true);
                addLog('🎉 All scraping jobs completed!');
                cleanup();
              }
              break;

            case 'error':
              completedCount++;
              setCompletedJobs(completedCount);
              setHasError(true);
              addLog(`❌ Job ${jobId} failed: ${data.error || 'Unknown error'}`);

              if (completedCount === jobIds.length) {
                setIsComplete(true);
                addLog('⚠️ All jobs completed with errors');
                cleanup();
              }
              break;

            case 'connected':
              addLog(`🔗 Connected to job ${jobId} stream`);
              break;
          }
        } catch (error) {
          console.error('Error parsing SSE data:', error);
        }
      };

      eventSource.onerror = (error) => {
        console.error(`EventSource error for job ${jobId}:`, error);
        addLog(`⚠️ Connection lost for job ${jobId}`);
      };
    }
  };

  const startJobs = async () => {
    const apiBase = getApiBaseUrl();
    let completedCount = 0;

    for (const jobId of jobIds) {
      try {
        // Only start the job if not in reconnect mode
        if (!reconnectMode) {
          const response = await fetch(`${apiBase}/scrapers/${jobId}/start`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            }
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.error || `HTTP ${response.status}`;
            throw new Error(errorMessage);
          }
        }

        // Connect to the job's log stream
        const eventSource = new EventSource(`${apiBase}/scrapers/${jobId}/stream`);
        eventSourcesRef.current.push(eventSource);

        eventSource.onmessage = (event) => {
          try {
            const data: LogEntry = JSON.parse(event.data);

            switch (data.type) {
              case 'log':
                if (data.message) {
                  addLog(data.message);
                }
                break;

              case 'progress':
                if (data.stats) {
                  addLog(`📊 Progress: ${data.stats.processed} processed, ${data.stats.failed} failed`);
                }
                break;

              case 'complete':
                completedCount++;
                setCompletedJobs(completedCount);
                addLog(`✅ Job ${jobId} completed successfully!`);

                if (completedCount === jobIds.length) {
                  setIsComplete(true);
                  addLog('🎉 All scraping jobs completed!');
                  cleanup();
                }
                break;

              case 'error':
                completedCount++;
                setCompletedJobs(completedCount);
                setHasError(true);
                addLog(`❌ Job ${jobId} failed: ${data.error || 'Unknown error'}`);

                if (completedCount === jobIds.length) {
                  setIsComplete(true);
                  addLog('⚠️ All jobs completed with errors');
                  cleanup();
                }
                break;

              case 'connected':
                addLog(`🔗 Connected to job ${jobId} stream`);
                break;
            }
          } catch (error) {
            console.error('Error parsing SSE data:', error);
          }
        };

        eventSource.onerror = (error) => {
          console.error(`EventSource error for job ${jobId}:`, error);
          addLog(`⚠️ Connection lost for job ${jobId}`);
        };

      } catch (error) {
        addLog(`❌ Failed to start job ${jobId}: ${(error as Error).message}`);
        completedCount++;
        setCompletedJobs(completedCount);
        setHasError(true);

        if (completedCount === jobIds.length) {
          setIsComplete(true);
          cleanup();
        }
      }
    }

    // Fallback timeout (5 minutes)
    setTimeout(() => {
      if (!isComplete) {
        addLog('⚠️ Jobs taking longer than expected, but still running...');
      }
    }, 5 * 60 * 1000);
  };

  const handleClose = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    // Clear started jobs tracking when modal truly closes and jobs are complete
    if (isComplete) {
      startedJobsRef.current.clear();
    }

    onClose();
  };

  return (
    <Dialog open={isOpen} onClose={handleClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" aria-hidden="true" />

      <div className="fixed inset-0 flex items-center justify-center p-4">
        <Dialog.Panel className="mx-auto max-w-4xl w-full bg-white rounded-lg shadow-xl">
          <div className="flex items-center justify-between p-6 border-b border-gray-200">
            <div>
              <Dialog.Title className="text-lg font-medium text-gray-900">
                Running Scrapers
              </Dialog.Title>
              <p className="mt-1 text-sm text-gray-500">
                Progress: {completedJobs}/{totalJobs} jobs completed
              </p>
            </div>

            <Button
              isIcon
              variant="ghost"
              onClick={handleClose}
              title="Close and continue running in background"
            >
              <XMarkIcon className="h-6 w-6" />
            </Button>
          </div>

          {/* Progress Bar */}
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-primary-600 h-2 rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${totalJobs > 0 ? (completedJobs / totalJobs) * 100 : 0}%`
                }}
              ></div>
            </div>
          </div>

          {/* Terminal Output */}
          <div className="h-96 bg-gray-900 text-green-400 p-4 font-mono text-sm overflow-y-auto">
            {logs.map((log, index) => (
              <div key={index} className="mb-1">
                {log}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between p-6 border-t border-gray-200 bg-gray-50">
            <div className="text-sm text-gray-600">
              {isComplete ? (
                hasError ? (
                  <span className="text-yellow-600 font-medium">⚠️ Scraping completed with errors</span>
                ) : (
                  <span className="text-green-600 font-medium">✅ Scraping completed successfully</span>
                )
              ) : (
                <span>⏳ Scraping in progress...</span>
              )}
            </div>

            <Button
              variant={isComplete ? 'solid' : 'soft'}
              color={isComplete ? undefined : 'gray'}
              onClick={handleClose}
              title={isComplete ? 'Close' : 'Close and continue running in background'}
            >
              {isComplete ? 'Close' : 'Close & Continue'}
            </Button>
          </div>
        </Dialog.Panel>
      </div>
    </Dialog>
  );
}