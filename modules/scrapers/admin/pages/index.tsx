import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Switch as RadixSwitch } from '@radix-ui/themes';
import { PlayIcon, PlusIcon, ClockIcon, CheckCircleIcon, XCircleIcon, EyeIcon, PencilIcon, DocumentDuplicateIcon, TrashIcon, DocumentTextIcon } from '@heroicons/react/24/outline';
import { ScraperService, Scraper, ScraperJob } from '@/utils/scraperService';
import { ConfirmModal, Card, Badge, Button, Tabs, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';
import { ScrollableTable } from '@/components/shared/table/ScrollableTable';
import { Page } from '@/components/shared/Page';
import { ScrapingModal } from './ScrapingModal';
import { ScraperEditorModal } from './ScraperEditorModal';
// import { ActiveJobsModal } from './ActiveJobsModal'; // Temporarily disabled due to client-side errors

export default function ScrapersPage() {
  const navigate = useNavigate();
  const location = useLocation();

  const [scrapers, setScrapers] = useState<Scraper[]>([]);
  const [recentJobs, setRecentJobs] = useState<ScraperJob[]>([]);
  const [stats, setStats] = useState({
    total_scrapers: 0,
    enabled_scrapers: 0,
    total_items_scraped: 0,
    jobs_last_24h: 0,
    successful_jobs_last_24h: 0
  });
  const [loading, setLoading] = useState(true);
  const [selectedScrapers, setSelectedScrapers] = useState<number[]>([]);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showScrapingModal, setShowScrapingModal] = useState(false);
  const [activeJobs, setActiveJobs] = useState<number[]>([]);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [showActiveJobsModal, setShowActiveJobsModal] = useState(false);
  const [activeJobsCount, setActiveJobsCount] = useState(0);
  const [showEditorModal, setShowEditorModal] = useState(false);
  const [editingScraper, setEditingScraper] = useState<Scraper | null>(null);
  const [jobToDelete, setJobToDelete] = useState<number | null>(null);

  // Jobs pagination
  const [jobsPage, setJobsPage] = useState(0);
  const [jobsPerPage] = useState(20);
  const [totalJobs, setTotalJobs] = useState(0);
  const [selectedJobs, setSelectedJobs] = useState<number[]>([]);
  const [showDeletePendingConfirm, setShowDeletePendingConfirm] = useState(false);

  // Jobs sorting and filtering
  const [sortColumn, setSortColumn] = useState<'status' | 'started_at' | 'scraper_name' | null>('status');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [statusFilter, setStatusFilter] = useState<string>('');

  // Get active tab from URL
  const searchParams = new URLSearchParams(location.search);
  const activeTab = searchParams.get('tab') || 'scrapers';

  // Check if we're in production (scrapers should only be scheduled in production)
  const isProduction = !import.meta.env.DEV;
  const canScheduleScrapers = ScraperService.canScheduleScrapers();

  useEffect(() => {
    loadData();
    loadActiveJobsCount();
    const interval = setInterval(loadActiveJobsCount, 10000);
    return () => clearInterval(interval);
  }, [jobsPage, sortColumn, sortDirection, statusFilter]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [scrapersResult, jobsResult, statsResult] = await Promise.all([
        ScraperService.getAllScrapers(),
        ScraperService.getRecentJobs(jobsPerPage, jobsPage * jobsPerPage, statusFilter || undefined, sortColumn || undefined, sortDirection),
        ScraperService.getScraperStats()
      ]);

      if (scrapersResult.data) {
        setScrapers(scrapersResult.data);
      } else if (scrapersResult.error) {
        console.error('Failed to load scrapers:', scrapersResult.error);
        setScrapers([]);
      }

      if (jobsResult.data) {
        setRecentJobs(jobsResult.data);
        setTotalJobs(jobsResult.total || 0);
      } else if (jobsResult.error) {
        console.error('Failed to load recent jobs:', jobsResult.error);
        setRecentJobs([]);
        setTotalJobs(0);
      }

      if (statsResult.data) {
        setStats(statsResult.data);
      } else if (statsResult.error) {
        console.error('Failed to load stats:', statsResult.error);
        setStats({
          total_scrapers: 0,
          enabled_scrapers: 0,
          total_items_scraped: 0,
          jobs_last_24h: 0,
          successful_jobs_last_24h: 0
        });
      }
    } catch (error) {
      console.error('Error loading scraper data:', error);
      // Set safe defaults
      setScrapers([]);
      setRecentJobs([]);
      setStats({
        total_scrapers: 0,
        enabled_scrapers: 0,
        total_items_scraped: 0,
        jobs_last_24h: 0,
        successful_jobs_last_24h: 0
      });
    } finally {
      setLoading(false);
    }
  };

  const loadActiveJobsCount = async () => {
    try {
      const result = await ScraperService.getActiveJobs();
      if (result.data) {
        setActiveJobsCount(result.data.length);
      }
    } catch (error) {
      console.error('Error loading active jobs count:', error);
      setActiveJobsCount(0);
    }
  };

  const handleToggleScraper = async (scraperId: number, enabled: boolean) => {
    const result = await ScraperService.toggleScraper(scraperId, enabled);
    if (result.success) {
      setScrapers(prev => prev.map(s =>
        s.id === scraperId ? { ...s, enabled } : s
      ));
    }
  };

  const handleSelectScraper = (scraperId: number) => {
    setSelectedScrapers(prev => {
      if (prev.includes(scraperId)) {
        return prev.filter(id => id !== scraperId);
      } else {
        return [...prev, scraperId];
      }
    });
  };

  const handleSelectAll = () => {
    const enabledScraperIds = scrapers.filter(s => s.enabled).map(s => s.id);
    if (selectedScrapers.length === enabledScraperIds.length) {
      setSelectedScrapers([]);
    } else {
      setSelectedScrapers(enabledScraperIds);
    }
  };

  const handleRunScrapers = () => {
    if (selectedScrapers.length === 0) return;
    setShowConfirmModal(true);
  };

  const confirmRunScrapers = async () => {
    setShowConfirmModal(false);

    try {
      // Create jobs first, BEFORE opening modal
      const result = await ScraperService.createScraperJobs(selectedScrapers, 'admin');
      if (result.data) {
        const jobIds = result.data.map((job: any) => job.job_id);

        // Set active jobs first
        setActiveJobs(jobIds);
        setIsReconnecting(false); // These are NEW jobs, not reconnecting

        // Wait a tick for state to update, then open modal
        // This ensures jobIds is populated when modal opens
        setTimeout(() => {
          setShowScrapingModal(true);
        }, 0);

        // Don't start jobs here - let the modal handle it to avoid double-starting
        loadData(); // Refresh data
      }
    } catch (error) {
      console.error('Error starting scraper jobs:', error);
    }
  };

  const handleScrapingComplete = () => {
    setShowScrapingModal(false);
    setActiveJobs([]);
    setIsReconnecting(false);
    setSelectedScrapers([]);
    loadData(); // Refresh data
    loadActiveJobsCount();
  };

  const handleViewRunningJob = (jobId: number) => {
    // Verify the job still exists in recentJobs
    const jobExists = recentJobs.some(job => job.id === jobId);
    if (!jobExists) {
      console.error('Job not found:', jobId);
      alert('This job no longer exists. Please refresh the page.');
      loadData(); // Refresh data
      return;
    }

    setActiveJobs([jobId]);
    setIsReconnecting(true); // Reconnecting to existing job
    setShowScrapingModal(true);
  };

  const handleViewJobLogs = (jobId: number) => {
    // View logs for completed/failed jobs
    const jobExists = recentJobs.some(job => job.id === jobId);
    if (!jobExists) {
      console.error('Job not found:', jobId);
      alert('This job no longer exists. Please refresh the page.');
      loadData();
      return;
    }

    setActiveJobs([jobId]);
    setIsReconnecting(true); // Viewing historical logs
    setShowScrapingModal(true);
  };

  const getStatusIcon = (status?: string) => {
    switch (status) {
      case 'running':
      case 'pending':
        return (
          <ClockIcon
            className="h-5 w-5 text-yellow-500"
            style={{
              animation: 'spin 3s linear infinite'
            }}
          />
        );
      case 'completed':
        return <CheckCircleIcon className="h-5 w-5 text-success-500" />;
      case 'failed':
        return <XCircleIcon className="h-5 w-5 text-error-500" />;
      default:
        return null;
    }
  };

  const getStatusText = (status?: string) => {
    switch (status) {
      case 'pending':
        return 'Pending';
      case 'running':
        return 'Running';
      case 'completed':
        return 'Completed';
      case 'failed':
        return 'Failed';
      default:
        return 'Never run';
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return 'Never';
    return new Date(dateString).toLocaleString();
  };

  const handleCreateScraper = () => {
    setEditingScraper(null);
    setShowEditorModal(true);
  };

  const handleEditScraper = (scraper: Scraper) => {
    setEditingScraper(scraper);
    setShowEditorModal(true);
  };

  const handleDuplicateScraper = (scraper: Scraper) => {
    // Create a copy without id fields so it's treated as new
    setEditingScraper({
      name: `${scraper.name} (Copy)`,
      description: scraper.description,
      scraper_type: scraper.scraper_type,
      event_type: scraper.event_type,
      base_url: scraper.base_url,
      enabled: false,
      config: scraper.config,
      created_at: '',
      updated_at: '',
      total_items_scraped: 0
    } as Scraper);
    setShowEditorModal(true);
  };

  const handleSaveScraper = async (scraperData: Partial<Scraper>) => {
    try {
      if (editingScraper?.id && editingScraper.id > 0) {
        // Update existing
        const result = await ScraperService.updateScraper(editingScraper.id, scraperData);
        if (result.error) {
          throw new Error(result.error.message || 'Failed to update scraper');
        }
      } else {
        // Create new (including duplicates)
        const result = await ScraperService.createScraper(scraperData as any);
        if (result.error) {
          throw new Error(result.error.message || 'Failed to create scraper');
        }
      }
      await loadData();
    } catch (error: any) {
      throw error;
    }
  };

  const handleDeleteJob = async (jobId: number) => {
    setJobToDelete(jobId);
  };

  const confirmDeleteJob = async () => {
    if (!jobToDelete) return;

    try {
      const result = await ScraperService.deleteJob(jobToDelete);
      if (result.error) {
        console.error('Failed to delete job:', result.error);
        alert('Failed to delete job');
      } else {
        await loadData();
      }
    } catch (error) {
      console.error('Error deleting job:', error);
      alert('Failed to delete job');
    } finally {
      setJobToDelete(null);
    }
  };

  const handleDeleteSelectedJobs = async () => {
    if (selectedJobs.length === 0) return;

    try {
      const result = await ScraperService.deleteJobs(selectedJobs);
      if (result.error) {
        console.error('Failed to delete jobs:', result.error);
        alert('Failed to delete selected jobs');
      } else {
        setSelectedJobs([]);
        await loadData();
        alert(`Successfully deleted ${result.deleted} job(s)`);
      }
    } catch (error) {
      console.error('Error deleting jobs:', error);
      alert('Failed to delete selected jobs');
    }
  };

  const handleDeleteAllPending = async () => {
    setShowDeletePendingConfirm(false);

    try {
      const result = await ScraperService.deletePendingJobs();
      if (result.error) {
        console.error('Failed to delete pending jobs:', result.error);
        alert('Failed to delete pending jobs');
      } else {
        setSelectedJobs([]);
        await loadData();
        alert(`Successfully deleted ${result.deleted} pending job(s)`);
      }
    } catch (error) {
      console.error('Error deleting pending jobs:', error);
      alert('Failed to delete pending jobs');
    }
  };

  const toggleJobSelection = (jobId: number) => {
    setSelectedJobs(prev =>
      prev.includes(jobId)
        ? prev.filter(id => id !== jobId)
        : [...prev, jobId]
    );
  };

  const toggleAllJobsSelection = () => {
    if (selectedJobs.length === recentJobs.length) {
      setSelectedJobs([]);
    } else {
      setSelectedJobs(recentJobs.map(job => job.id));
    }
  };

  const handleTabChange = (tab: string) => {
    navigate(`?tab=${tab}`);
  };

  const handleSort = (column: 'status' | 'started_at' | 'scraper_name') => {
    if (sortColumn === column) {
      // Toggle direction
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      // New column, default to ascending
      setSortColumn(column);
      setSortDirection('asc');
    }
    // Reset to first page when sorting changes
    setJobsPage(0);
  };

  const handleStatusFilterChange = (status: string) => {
    setStatusFilter(status);
    setJobsPage(0); // Reset to first page when filter changes
  };

  const SortIcon = ({ column }: { column: string }) => {
    if (sortColumn !== column) {
      return <span className="ml-1 text-[var(--gray-a9)]">↕</span>;
    }
    return <span className="ml-1">{sortDirection === 'asc' ? '↑' : '↓'}</span>;
  };

  const pendingJobsCount = recentJobs.filter(job => job.status === 'pending').length;
  const totalPages = Math.ceil(totalJobs / jobsPerPage);

  if (loading) {
    return (
      <Page title="Event Scrapers">
        <div className="p-6 animate-pulse">
          <div className="h-8 bg-neutral-200 rounded mb-6"></div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="p-6">
                <div className="h-4 bg-neutral-200 rounded mb-2"></div>
                <div className="h-8 bg-neutral-200 rounded"></div>
              </div>
            ))}
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Event Scrapers">
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
          Event Scrapers
        </h1>
        <p className="text-[var(--gray-11)] mt-1">Manage and run automated event scrapers</p>

        {!isProduction && (
          <div className="mt-4 p-4 bg-warning-50 border border-warning-200 rounded-lg">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <svg className="h-5 w-5 text-warning-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="ml-3">
                <h3 className="text-sm font-medium text-warning-800">Development Mode</h3>
                <div className="mt-2 text-sm text-warning-700">
                  <p>You are running scrapers in development mode. Scrapers can be manually tested here, but automatic scheduling is disabled. Scheduled scrapers will only run in production.</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-6 mb-8">
        <Card variant="surface" className="p-6">
          <div className="text-sm font-medium text-neutral-500">Total Scrapers</div>
          <div className="text-2xl font-bold">{stats.total_scrapers}</div>
        </Card>
        <Card variant="surface" className="p-6">
          <div className="text-sm font-medium text-neutral-500">Enabled</div>
          <div className="text-2xl font-bold text-success-600">{stats.enabled_scrapers}</div>
        </Card>
        <Card variant="surface" className="p-6">
          <div className="text-sm font-medium text-neutral-500">Total Events</div>
          <div className="text-2xl font-bold text-info-600">{stats.total_items_scraped.toLocaleString()}</div>
        </Card>
        <Card variant="surface" className="p-6">
          <div className="text-sm font-medium text-neutral-500">Jobs (24h)</div>
          <div className="text-2xl font-bold">{stats.jobs_last_24h}</div>
        </Card>
        <Card variant="surface" className="p-6">
          <div className="text-sm font-medium text-neutral-500">Success Rate</div>
          <div className="text-2xl font-bold text-success-600">
            {stats.jobs_last_24h > 0
              ? Math.round((stats.successful_jobs_last_24h / stats.jobs_last_24h) * 100)
              : 0}%
          </div>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onChange={handleTabChange}
        tabs={[
          { id: 'scrapers', label: 'Scrapers', count: stats.total_scrapers },
          { id: 'jobs', label: 'Recent Jobs', count: totalJobs }
        ]}
        className="mb-6"
      />

      {/* Scrapers Tab */}
      {activeTab === 'scrapers' && (
        <>
          {/* Actions Bar */}
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center space-x-4">
          <Button
            variant="ghost"
            color="cyan"
            onClick={handleSelectAll}
          >
            {selectedScrapers.length === scrapers.filter(s => s.enabled).length ? 'Deselect All' : 'Select All'}
          </Button>
          {selectedScrapers.length > 0 && (
            <span className="text-sm text-neutral-500">
              {selectedScrapers.length} scraper{selectedScrapers.length > 1 ? 's' : ''} selected
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Temporarily disabled Active Jobs button due to modal errors
          {activeJobsCount > 0 && (
            <button
              onClick={() => setShowActiveJobsModal(true)}
              className="flex items-center px-3 py-2 rounded-md font-medium bg-warning-100 text-warning-700 hover:bg-warning-200"
            >
              <ClockIcon
                className="h-5 w-5 mr-2"
                style={{ animation: 'spin 3s linear infinite' }}
              />
              {activeJobsCount} Active Job{activeJobsCount > 1 ? 's' : ''}
            </button>
          )}
          */}

          <Button
            variant="solid"
            onClick={handleCreateScraper}
          >
            <PlusIcon className="h-5 w-5 mr-2" />
            Create Scraper
          </Button>

          <Button
            variant="solid"
            onClick={handleRunScrapers}
            disabled={selectedScrapers.length === 0}
          >
            <PlayIcon className="h-5 w-5 mr-2" />
            Run Selected Scrapers
          </Button>
        </div>
      </div>

      {/* Scrapers Table */}
      <Card variant="surface" className="overflow-hidden mb-8">
        <ScrollableTable>
          <Table>
          <THead>
            <Tr>
              <Th data-sticky-left style={{ position: 'sticky', left: 0, zIndex: 20, background: 'var(--color-panel-solid)' }}>
                <input
                  type="checkbox"
                  checked={selectedScrapers.length === scrapers.filter(s => s.enabled).length && scrapers.filter(s => s.enabled).length > 0}
                  onChange={handleSelectAll}
                />
              </Th>
              <Th>Name</Th>
              <Th>Object Type</Th>
              <Th>Category</Th>
              <Th>Status</Th>
              <Th>Last Run</Th>
              {canScheduleScrapers && (
                <Th>Schedule</Th>
              )}
              <Th>Items Found</Th>
              <Th>Enabled</Th>
              <Th data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 2 }} />
            </Tr>
          </THead>
          <TBody>
            {scrapers.map((scraper) => (
              <Tr key={scraper.id}>
                <Td data-sticky-left style={{ position: 'sticky', left: 0, zIndex: 10, background: 'var(--color-panel-solid)' }}>
                  <input
                    type="checkbox"
                    checked={selectedScrapers.includes(scraper.id)}
                    onChange={() => handleSelectScraper(scraper.id)}
                    disabled={!scraper.enabled}
                  />
                </Td>
                <Td>
                  <div>
                    <div className="text-sm font-medium">{scraper.name}</div>
                    <div className="text-sm text-[var(--gray-a11)]">{scraper.description}</div>
                  </div>
                </Td>
                <Td>
                  <Badge
                    color={scraper.object_type === 'events' ? 'info' : 'success'}
                    variant="soft"
                  >
                    {scraper.object_type || 'events'}
                  </Badge>
                </Td>
                <Td>
                  <Badge
                    color={scraper.event_type === 'conference' ? 'info' : 'success'}
                    variant="soft"
                  >
                    {scraper.event_type}
                  </Badge>
                </Td>
                <Td>
                  <div className="flex items-center">
                    {getStatusIcon(scraper.latest_job_status)}
                    <span className="ml-2 text-sm">
                      {getStatusText(scraper.latest_job_status)}
                    </span>
                  </div>
                </Td>
                <Td>
                  <span className="text-sm text-[var(--gray-a11)]">{formatDate(scraper.last_run)}</span>
                </Td>
                {canScheduleScrapers && (
                  <Td>
                    {scraper.schedule_enabled && scraper.schedule_frequency && scraper.schedule_frequency !== 'none' ? (
                      <div className="flex flex-col">
                        <Badge color="info" variant="soft" className="text-xs mb-1">
                          {scraper.schedule_frequency}
                        </Badge>
                        {scraper.next_scheduled_run && (
                          <span className="text-xs text-[var(--gray-a9)]">
                            Next: {new Date(scraper.next_scheduled_run).toLocaleString()}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-[var(--gray-a9)]">Manual</span>
                    )}
                  </Td>
                )}
                <Td>
                  {scraper.total_items_scraped > 0 ? (
                    <Button
                      variant="ghost"
                      color="blue"
                      onClick={() => window.location.href = `/events?scraperName=${encodeURIComponent(scraper.name)}`}
                    >
                      {scraper.total_items_scraped.toLocaleString()}
                    </Button>
                  ) : (
                    <span className="text-[var(--gray-a9)]">0</span>
                  )}
                </Td>
                <Td>
                  <RadixSwitch
                    checked={scraper.enabled}
                    onCheckedChange={(checked) => handleToggleScraper(scraper.id, checked)}
                  />
                </Td>
                <Td data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 1 }}>
                  <RowActions actions={[
                    { label: "Run", icon: <PlayIcon className="size-4" />, onClick: () => { setSelectedScrapers([scraper.id]); setShowConfirmModal(true); }, disabled: !scraper.enabled },
                    { label: "Edit", icon: <PencilIcon className="size-4" />, onClick: () => handleEditScraper(scraper) },
                    { label: "Duplicate", icon: <DocumentDuplicateIcon className="size-4" />, onClick: () => handleDuplicateScraper(scraper) },
                  ]} />
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
        </ScrollableTable>
      </Card>
        </>
      )}

      {/* Recent Jobs Tab */}
      {activeTab === 'jobs' && (
        <>
      {/* Recent Jobs */}
      <Card variant="surface" className="overflow-hidden">
        <div className="px-6 py-4 border-b border-[var(--gray-a6)] flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div>
              <h3 className="text-lg font-medium text-[var(--gray-12)]">Recent Jobs</h3>
              <p className="text-sm text-[var(--gray-a11)] mt-1">
                Showing {recentJobs.length} of {totalJobs} jobs {pendingJobsCount > 0 && `(${pendingJobsCount} pending)`}
              </p>
            </div>

            {/* Status Filter */}
            <div className="flex items-center gap-2">
              <label htmlFor="status-filter" className="text-sm text-[var(--gray-a11)]">
                Status:
              </label>
              <select
                id="status-filter"
                value={statusFilter}
                onChange={(e) => handleStatusFilterChange(e.target.value)}
                className="rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-1.5 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <option value="">All</option>
                <option value="pending">Pending</option>
                <option value="running">Running</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
              </select>
            </div>
          </div>

          <div className="flex gap-2">
            {selectedJobs.length > 0 && (
              <Button
                variant="soft"
                color="red"
                onClick={handleDeleteSelectedJobs}
              >
                <TrashIcon className="h-4 w-4 mr-1" />
                Delete Selected ({selectedJobs.length})
              </Button>
            )}
            {pendingJobsCount > 0 && (
              <Button
                variant="outline"
                color="red"
                onClick={() => setShowDeletePendingConfirm(true)}
              >
                <TrashIcon className="h-4 w-4 mr-1" />
                Delete All Pending ({pendingJobsCount})
              </Button>
            )}
          </div>
        </div>
        <ScrollableTable>
          <Table>
            <THead>
              <Tr>
                <Th data-sticky-left style={{ position: 'sticky', left: 0, zIndex: 20, background: 'var(--color-panel-solid)' }}>
                  <input
                    type="checkbox"
                    checked={selectedJobs.length === recentJobs.length && recentJobs.length > 0}
                    onChange={toggleAllJobsSelection}
                  />
                </Th>
                <Th>
                  <div className="flex items-center cursor-pointer" onClick={() => handleSort('scraper_name')}>
                    Scraper
                    <SortIcon column="scraper_name" />
                  </div>
                </Th>
                <Th>
                  <div className="flex items-center cursor-pointer" onClick={() => handleSort('status')}>
                    Status
                    <SortIcon column="status" />
                  </div>
                </Th>
                <Th>
                  <div className="flex items-center cursor-pointer" onClick={() => handleSort('started_at')}>
                    Started
                    <SortIcon column="started_at" />
                  </div>
                </Th>
                <Th>Duration</Th>
                <Th>Results</Th>
                <Th>Created By</Th>
                <Th data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 2 }} />
              </Tr>
            </THead>
            <TBody>
              {recentJobs.filter(job => job && job.id).map((job) => {
                if (!job || !job.id) return null;

                const duration = job.completed_at && job.started_at
                  ? Math.round((new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 1000)
                  : null;

                return (
                  <Tr key={job.id}>
                    <Td data-sticky-left style={{ position: 'sticky', left: 0, zIndex: 10, background: 'var(--color-panel-solid)' }}>
                      <input
                        type="checkbox"
                        checked={selectedJobs.includes(job.id)}
                        onChange={() => toggleJobSelection(job.id)}
                      />
                    </Td>
                    <Td>
                      <div>
                        <div className="text-sm font-medium">{job.scraper_name}</div>
                        <div className="text-sm text-[var(--gray-a11)]">{job.event_type}</div>
                      </div>
                    </Td>
                    <Td>
                      <div className="flex items-center">
                        {getStatusIcon(job.status)}
                        <span className="ml-2 text-sm">
                          {getStatusText(job.status)}
                        </span>
                      </div>
                    </Td>
                    <Td>
                      <span className="text-sm text-[var(--gray-a11)]">{formatDate(job.started_at)}</span>
                    </Td>
                    <Td>
                      <span className="text-sm text-[var(--gray-a11)]">{duration ? `${duration}s` : '-'}</span>
                    </Td>
                    <Td>
                      {job.status === 'completed' ? (
                        <span className="text-sm">{job.items_processed || job.events_processed || 0} processed, {job.items_skipped || job.events_skipped || 0} skipped</span>
                      ) : job.status === 'failed' ? (
                        <span className="text-sm text-[var(--red-11)]">{job.error_message || 'Failed'}</span>
                      ) : (
                        <span className="text-sm">-</span>
                      )}
                    </Td>
                    <Td>
                      <span className="text-sm text-[var(--gray-a11)]">{job.created_by}</span>
                    </Td>
                    <Td data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 1 }}>
                      <RowActions actions={[
                        { label: job.status === 'running' || job.status === 'pending' ? "View Live Logs" : "View Logs",
                          icon: job.status === 'running' || job.status === 'pending' ? <EyeIcon className="size-4" /> : <DocumentTextIcon className="size-4" />,
                          onClick: () => job.status === 'running' || job.status === 'pending' ? handleViewRunningJob(job.id) : handleViewJobLogs(job.id) },
                        { label: "Delete", icon: <TrashIcon className="size-4" />, onClick: () => handleDeleteJob(job.id), color: "red" },
                      ]} />
                    </Td>
                  </Tr>
                );
              })}
              {recentJobs.length === 0 && (
                <Tr>
                  <Td colSpan={8} className="text-center text-[var(--gray-a11)]">
                    No recent jobs found
                  </Td>
                </Tr>
              )}
            </TBody>
          </Table>
        </ScrollableTable>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-6 py-4 border-t border-[var(--gray-a6)] flex items-center justify-between">
            <div className="text-sm text-[var(--gray-a11)]">
              Page {jobsPage + 1} of {totalPages}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                color="gray"
                onClick={() => setJobsPage(p => Math.max(0, p - 1))}
                disabled={jobsPage === 0}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                color="gray"
                onClick={() => setJobsPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={jobsPage >= totalPages - 1}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
        </>
      )}

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={showConfirmModal}
        onClose={() => setShowConfirmModal(false)}
        onConfirm={confirmRunScrapers}
        title="Run Scrapers"
        message={
          !isProduction
            ? `⚠️ Development Mode: You are about to manually run ${selectedScrapers.length} scraper${selectedScrapers.length > 1 ? 's' : ''} for testing. This will start background jobs to scrape events from the configured sources. Note that automatic scheduling is disabled in development mode.`
            : `Are you sure you want to run ${selectedScrapers.length} scraper${selectedScrapers.length > 1 ? 's' : ''}? This will start background jobs to scrape events from the configured sources.`
        }
        confirmText="Run Scrapers"
        confirmColor="blue"
      />

      {/* Scraping Modal */}
      <ScrapingModal
        isOpen={showScrapingModal}
        onClose={handleScrapingComplete}
        jobIds={activeJobs}
        reconnectMode={isReconnecting}
      />

      {/* Active Jobs Modal - Temporarily disabled due to client-side errors
      {showActiveJobsModal && (
        <ActiveJobsModal
          isOpen={showActiveJobsModal}
          onClose={() => setShowActiveJobsModal(false)}
        />
      )}
      */}

      {/* Scraper Editor Modal */}
      <ScraperEditorModal
        isOpen={showEditorModal}
        onClose={() => {
          setShowEditorModal(false);
          setEditingScraper(null);
        }}
        onSave={handleSaveScraper}
        scraper={editingScraper}
      />

      {/* Delete Job Confirmation Modal */}
      <ConfirmModal
        isOpen={jobToDelete !== null}
        onClose={() => setJobToDelete(null)}
        onConfirm={confirmDeleteJob}
        title="Delete Scraper Job"
        message="Are you sure you want to delete this scraper job? This action cannot be undone."
        confirmText="Delete"
        confirmColor="red"
      />

      {/* Delete All Pending Jobs Confirmation Modal */}
      <ConfirmModal
        isOpen={showDeletePendingConfirm}
        onClose={() => setShowDeletePendingConfirm(false)}
        onConfirm={handleDeleteAllPending}
        title="Delete All Pending Jobs"
        message={`Are you sure you want to delete all ${pendingJobsCount} pending scraper job(s)? This action cannot be undone.`}
        confirmText="Delete All Pending"
        confirmColor="red"
      />
    </div>
    </Page>
  );
}