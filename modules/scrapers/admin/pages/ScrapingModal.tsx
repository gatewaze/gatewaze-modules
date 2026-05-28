import { useState, useEffect, useRef } from 'react';
import { Modal, Button } from '@/components/ui';
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
  const startedJobsRef = useRef<Set<number>>(new Set());
  const prevJobIdsRef = useRef<string>('');

  useEffect(() => {
    if (isOpen && jobIds.length > 0) {
      const currentJobIdsKey = [...jobIds].sort((a, b) => a - b).join(',');
      const hasJobIdsChanged = currentJobIdsKey !== prevJobIdsRef.current;

      if (hasJobIdsChanged) {
        prevJobIdsRef.current = currentJobIdsKey;

        setLogs([]);
        setIsComplete(false);
        setCompletedJobs(0);
        setTotalJobs(jobIds.length);
        setHasError(false);

        if (reconnectMode) {
          addLog(`Loading historical logs for job ${jobIds[0]}...`);
          loadHistoricalLogsAndConnect();
        } else {
          addLog(`Starting scraping jobs for ${jobIds.length} scraper${jobIds.length > 1 ? 's' : ''}...`);
          jobIds.forEach(id => startedJobsRef.current.add(id));
          startJobs();
        }
      }
    }

    if (!isOpen) {
      cleanup();
      if (isComplete) {
        prevJobIdsRef.current = '';
        setLogs([]);
      }
    }

    return () => { if (!isOpen) cleanup(); };
  }, [isOpen, jobIds, isComplete]);

  useEffect(() => { scrollToBottom(); }, [logs]);

  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, `[${timestamp}] ${message}`]);
  };

  const scrollToBottom = () => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });

  const cleanup = () => {
    eventSourcesRef.current.forEach(es => es.close());
    eventSourcesRef.current = [];
    if (intervalRef.current) clearInterval(intervalRef.current);
  };

  const fetchHistoricalLogs = async (jobId: number): Promise<LogEntry[]> => {
    const apiBase = getApiBaseUrl();
    try {
      const response = await fetch(`${apiBase}/scrapers/${jobId}/logs`);
      if (!response.ok) return [];
      return await response.json();
    } catch { return []; }
  };

  const processHistoricalLogs = (allLogs: LogEntry[]) => {
    allLogs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    if (allLogs.length > 0) {
      addLog(`Loaded ${allLogs.length} historical log entries`);
      for (const log of allLogs) {
        switch (log.type) {
          case 'log': if (log.message) setLogs(prev => [...prev, log.message as string]); break;
          case 'progress': if (log.metadata) addLog(`Progress: ${log.metadata.processed || 0} processed, ${log.metadata.failed || 0} failed`); break;
          case 'error': if (log.message) addLog(`Error: ${log.message}`); break;
          case 'complete': if (log.message) addLog(log.message); break;
        }
      }
    }
  };

  const loadHistoricalLogsAndConnect = async () => {
    const allHistoricalLogs: LogEntry[] = [];
    for (const jobId of jobIds) {
      allHistoricalLogs.push(...await fetchHistoricalLogs(jobId));
    }
    processHistoricalLogs(allHistoricalLogs);
    if (allHistoricalLogs.length === 0) addLog('No historical logs found, connecting to live stream...');
    else addLog('Connecting to live stream...');
    connectToStreams();
  };

  const connectToStreams = () => {
    const apiBase = getApiBaseUrl();
    let completedCount = 0;

    for (const jobId of jobIds) {
      const eventSource = new EventSource(`${apiBase}/scrapers/${jobId}/stream`);
      eventSourcesRef.current.push(eventSource);

      eventSource.onmessage = (event) => {
        try {
          const data: LogEntry = JSON.parse(event.data);
          switch (data.type) {
            case 'log': if (data.message) addLog(data.message); break;
            case 'progress': if (data.stats) addLog(`Progress: ${data.stats.processed} processed, ${data.stats.failed} failed`); break;
            case 'complete':
              completedCount++;
              setCompletedJobs(completedCount);
              addLog(`Job ${jobId} completed successfully!`);
              if (completedCount === jobIds.length) { setIsComplete(true); addLog('All scraping jobs completed!'); cleanup(); }
              break;
            case 'error':
              completedCount++;
              setCompletedJobs(completedCount);
              setHasError(true);
              addLog(`Job ${jobId} failed: ${data.error || 'Unknown error'}`);
              if (completedCount === jobIds.length) { setIsComplete(true); addLog('All jobs completed with errors'); cleanup(); }
              break;
            case 'connected': addLog(`Connected to job ${jobId} stream`); break;
          }
        } catch (error) { console.error('Error parsing SSE data:', error); }
      };

      eventSource.onerror = () => addLog(`Connection lost for job ${jobId}`);
    }
  };

  const startJobs = async () => {
    const apiBase = getApiBaseUrl();
    let completedCount = 0;

    for (const jobId of jobIds) {
      try {
        if (!reconnectMode) {
          const response = await fetch(`${apiBase}/scrapers/${jobId}/start`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }
          });
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `HTTP ${response.status}`);
          }
        }

        const eventSource = new EventSource(`${apiBase}/scrapers/${jobId}/stream`);
        eventSourcesRef.current.push(eventSource);

        eventSource.onmessage = (event) => {
          try {
            const data: LogEntry = JSON.parse(event.data);
            switch (data.type) {
              case 'log': if (data.message) addLog(data.message); break;
              case 'progress': if (data.stats) addLog(`Progress: ${data.stats.processed} processed, ${data.stats.failed} failed`); break;
              case 'complete':
                completedCount++;
                setCompletedJobs(completedCount);
                addLog(`Job ${jobId} completed successfully!`);
                if (completedCount === jobIds.length) { setIsComplete(true); addLog('All scraping jobs completed!'); cleanup(); }
                break;
              case 'error':
                completedCount++;
                setCompletedJobs(completedCount);
                setHasError(true);
                addLog(`Job ${jobId} failed: ${data.error || 'Unknown error'}`);
                if (completedCount === jobIds.length) { setIsComplete(true); addLog('All jobs completed with errors'); cleanup(); }
                break;
              case 'connected': addLog(`Connected to job ${jobId} stream`); break;
            }
          } catch (error) { console.error('Error parsing SSE data:', error); }
        };

        eventSource.onerror = () => addLog(`Connection lost for job ${jobId}`);
      } catch (error) {
        addLog(`Failed to start job ${jobId}: ${(error as Error).message}`);
        completedCount++;
        setCompletedJobs(completedCount);
        setHasError(true);
        if (completedCount === jobIds.length) { setIsComplete(true); cleanup(); }
      }
    }

    setTimeout(() => {
      if (!isComplete) addLog('Jobs taking longer than expected, but still running...');
    }, 5 * 60 * 1000);
  };

  const handleClose = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (isComplete) startedJobsRef.current.clear();
    onClose();
  };

  const progressPct = totalJobs > 0 ? (completedJobs / totalJobs) * 100 : 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Running Scrapers"
      size="xl"
      footer={
        <div className="flex items-center justify-between">
          <div className="text-sm text-[var(--gray-9)]">
            {isComplete ? (
              hasError ? <span className="text-yellow-600 font-medium">Scraping completed with errors</span>
                : <span className="text-green-600 font-medium">Scraping completed successfully</span>
            ) : <span>Scraping in progress...</span>}
          </div>
          <Button variant={isComplete ? 'solid' : 'outline'} onClick={handleClose}>
            {isComplete ? 'Close' : 'Close & Continue'}
          </Button>
        </div>
      }
    >
      <p className="text-sm text-[var(--gray-9)] mb-3">
        Progress: {completedJobs}/{totalJobs} jobs completed
      </p>

      {/* Progress Bar */}
      <div className="mb-3">
        <div className="w-full bg-[var(--gray-a4)] rounded-full h-2">
          <div
            className="bg-[var(--accent-9)] h-2 rounded-full transition-all duration-500 ease-out"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Terminal Output */}
      <div className="h-80 bg-gray-900 text-green-400 p-4 font-mono text-sm overflow-y-auto rounded-lg">
        {logs.map((log, index) => (
          <div key={index} className="mb-1">{log}</div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </Modal>
  );
}
