import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router';
import {
  LinkIcon,
  ArrowPathIcon,
  MagnifyingGlassIcon,
  ClipboardDocumentIcon,
  ArrowTopRightOnSquareIcon,
  ChartBarIcon,
  EyeIcon,
  CalendarIcon,
  DocumentMagnifyingGlassIcon,
  XMarkIcon,
  PencilIcon,
  CheckIcon,
} from '@heroicons/react/24/outline';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  createColumnHelper,
  SortingState,
  PaginationState,
} from '@tanstack/react-table';

import { DataTable } from '@/components/shared/table/DataTable';
import { RowActions } from '@/components/shared/table/RowActions';
import { toast } from 'sonner';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { Page } from '@/components/shared/Page';
import { Card, Badge, Button } from '@/components/ui';
import { Flatpickr } from '@/components/shared/form/Flatpickr';
import { supabase } from '@/lib/supabase';
import { getShortLinkDomain } from '@/config/brands';

// Import flatpickr CSS
import 'flatpickr/dist/flatpickr.min.css';

// Types
interface Redirect {
  id: string;
  shortio_id: string;
  original_url: string;
  short_url: string;
  secure_short_url: string | null;
  path: string;
  domain: string;
  title: string | null;
  archived: boolean;
  tags: string[] | null;
  total_clicks: number;
  unique_clicks: number;
  human_clicks: number;
  source_type: string | null;
  source_id: string | null;
  shortio_created_at: string | null;
  last_totals_synced_at: string | null;
  created_at: string;
  updated_at: string;
  // Categorization fields
  link_category: string | null;
  newsletter_date: string | null;
  distribution_channel: string | null;
  content_type: string | null;
  content_number: number | null;
  platform: string | null;
}

// Content type colors and options (matching NewsletterTrendsTab)
const CONTENT_TYPE_COLORS: Record<string, string> = {
  podcast: '#8B5CF6',
  gem: '#F59E0B',
  blog: '#3B82F6',
  hot_take: '#EF4444',
  job: '#10B981',
  reading_group: '#6366F1',
  ad: '#EC4899',
  intro: '#06B6D4',
  rewind: '#F97316',
  shop: '#14B8A6',
};

const CONTENT_TYPES = [
  'podcast',
  'gem',
  'blog',
  'hot_take',
  'job',
  'reading_group',
  'ad',
  'intro',
  'rewind',
  'shop',
];

const LINK_CATEGORIES = ['newsletter', 'campaign', 'social', 'other'];
const DISTRIBUTION_CHANNELS = ['email', 'linkedin', 'twitter', 'other'];

interface RedirectStats {
  domain: string;
  total_redirects: number;
  active_redirects: number;
  archived_redirects: number;
  total_clicks: number;
  unique_clicks: number;
}

interface SyncLog {
  id: string;
  domain: string;
  status: string;
  total_links: number;
  new_links: number;
  updated_links: number;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

const columnHelper = createColumnHelper<Redirect>();

// Active sync progress tracking
interface ActiveSync {
  syncLogId: string;
  type: 'sync' | 'history' | 'yesterday' | 'totals';
  total: number;
  processed: number;
  updated: number;
}

export default function RedirectsPage() {
  const navigate = useNavigate();
  const [redirects, setRedirects] = useState<Redirect[]>([]);
  const [stats, setStats] = useState<RedirectStats | null>(null);
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncingHistory, setSyncingHistory] = useState(false);
  const [syncingYesterday, setSyncingYesterday] = useState(false);
  const [syncingTotals, setSyncingTotals] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'total_clicks', desc: true },
  ]);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 25,
  });
  const [activeSync, setActiveSync] = useState<ActiveSync | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const startPollingProgressRef = useRef<((syncLogId: string, type: ActiveSync['type']) => void) | null>(null);
  const activeSyncRef = useRef<ActiveSync | null>(null);
  const loadDataRef = useRef<(() => Promise<void>) | null>(null);
  const lastReloadAtRef = useRef<number>(0); // Track last reload milestone to avoid duplicates

  // Edit state for categorization
  const [editingRedirectId, setEditingRedirectId] = useState<string | null>(null);
  const [editLinkCategory, setEditLinkCategory] = useState<string>('');
  const [editContentType, setEditContentType] = useState<string>('');
  const [editContentNumber, setEditContentNumber] = useState<string>('');
  const [editNewsletterDate, setEditNewsletterDate] = useState<string>('');
  const [editDistributionChannel, setEditDistributionChannel] = useState<string>('');
  const [savingEdit, setSavingEdit] = useState(false);

  // Keep refs in sync with state/callbacks
  activeSyncRef.current = activeSync;

  // Get the current brand's Short.io domain
  const shortIoDomain = getShortLinkDomain();

  // Refs for realtime channels
  const redirectsChannelRef = useRef<RealtimeChannel | null>(null);
  const syncLogsChannelRef = useRef<RealtimeChannel | null>(null);

  // Memoize loadData to use in subscriptions
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // Load ALL redirects for the current brand's domain using pagination
      // Supabase has a default limit of 1000 rows, so we need to paginate
      let allRedirects: Redirect[] = [];
      let offset = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const { data: redirectsBatch, error: redirectsError } = await supabase
          .from('redirects')
          .select('*')
          .eq('domain', shortIoDomain)
          .order('total_clicks', { ascending: false })
          .range(offset, offset + pageSize - 1);

        if (redirectsError) {
          console.error('Error loading redirects:', redirectsError);
          toast.error('Failed to load redirects');
          break;
        }

        if (redirectsBatch && redirectsBatch.length > 0) {
          allRedirects = allRedirects.concat(redirectsBatch);
          offset += pageSize;
          hasMore = redirectsBatch.length === pageSize;
        } else {
          hasMore = false;
        }
      }

      setRedirects(allRedirects);
      console.log(`Loaded ${allRedirects.length} total redirects`);

      // Load stats (keeping for reference, but liveStats is used for display)
      const { data: statsData, error: statsError } = await supabase
        .from('redirects_stats')
        .select('*')
        .eq('domain', shortIoDomain)
        .single();

      if (!statsError && statsData) {
        setStats(statsData);
      }

      // Load recent sync logs
      const { data: logsData, error: logsError } = await supabase
        .from('redirects_sync_logs')
        .select('*')
        .eq('domain', shortIoDomain)
        .order('created_at', { ascending: false })
        .limit(5);

      if (!logsError && logsData) {
        setSyncLogs(logsData);

        // Check for any running syncs and resume tracking them
        const runningSync = logsData.find((log: SyncLog) => log.status === 'running');
        if (runningSync && !activeSyncRef.current) {
          // Determine sync type from context (we can infer from the log or just use 'totals' as default)
          // For now, we'll just track it generically
          console.log('Found running sync, resuming progress tracking:', runningSync.id);
          setActiveSync({
            syncLogId: runningSync.id,
            type: 'totals', // Default, will be updated by polling
            total: runningSync.total_links || 0,
            processed: runningSync.new_links || 0,
            updated: runningSync.updated_links || 0,
          });
          // Start polling if not already polling
          if (!pollIntervalRef.current) {
            startPollingProgressRef.current?.(runningSync.id, 'totals');
          }
        }
      }
    } catch (error) {
      console.error('Error loading data:', error);
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [shortIoDomain]);

  // Keep loadData ref updated
  loadDataRef.current = loadData;

  // Initial load and realtime subscriptions
  useEffect(() => {
    loadData();

    // Subscribe to redirects table changes
    // Note: Remove filter to receive all updates for the table, then filter client-side
    // This is more reliable as some Supabase realtime filters can be restrictive
    redirectsChannelRef.current = supabase
      .channel('redirects-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'redirects',
        },
        (payload) => {
          const updatedRedirect = payload.new as Redirect;
          const oldRedirect = payload.old as Redirect;

          // Filter client-side by domain
          const redirectDomain = updatedRedirect?.domain || oldRedirect?.domain;
          if (redirectDomain !== shortIoDomain) return;

          if (payload.eventType === 'INSERT') {
            console.log('Redirect INSERT:', updatedRedirect.path);
            // Add new redirect to the list
            setRedirects((prev) => {
              // Check if it already exists (avoid duplicates)
              if (prev.some((r) => r.id === updatedRedirect.id)) {
                return prev;
              }
              return [updatedRedirect, ...prev];
            });
          } else if (payload.eventType === 'UPDATE') {
            // Update existing redirect - this triggers liveStats recalculation
            setRedirects((prev) => {
              const index = prev.findIndex((r) => r.id === updatedRedirect.id);
              if (index === -1) return prev;

              // Only log if click counts changed
              const existing = prev[index];
              if (existing.total_clicks !== updatedRedirect.total_clicks ||
                  existing.unique_clicks !== updatedRedirect.unique_clicks) {
                console.log(`Redirect UPDATE: /${updatedRedirect.path} - clicks: ${existing.total_clicks} → ${updatedRedirect.total_clicks}`);
              }

              // Create new array to trigger re-render
              const newArray = [...prev];
              newArray[index] = updatedRedirect;
              return newArray;
            });
          } else if (payload.eventType === 'DELETE') {
            console.log('Redirect DELETE:', oldRedirect?.path);
            // Remove deleted redirect
            setRedirects((prev) => prev.filter((r) => r.id !== oldRedirect?.id));
          }
        }
      )
      .subscribe((status) => {
        console.log('Redirects realtime subscription status:', status);
      });

    // Subscribe to sync logs changes
    syncLogsChannelRef.current = supabase
      .channel('sync-logs-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'redirects_sync_logs',
          filter: `domain=eq.${shortIoDomain}`,
        },
        (payload) => {
          console.log('Sync log change received:', payload.eventType);

          if (payload.eventType === 'INSERT') {
            setSyncLogs((prev) => {
              const newLog = payload.new as SyncLog;
              if (prev.some((l) => l.id === newLog.id)) {
                return prev;
              }
              return [newLog, ...prev].slice(0, 5);
            });
          } else if (payload.eventType === 'UPDATE') {
            setSyncLogs((prev) =>
              prev.map((l) => (l.id === (payload.new as SyncLog).id ? (payload.new as SyncLog) : l))
            );
            // If sync completed, show a toast
            const updatedLog = payload.new as SyncLog;
            if (updatedLog.status === 'completed') {
              toast.success(`Sync completed: ${updatedLog.new_links} new, ${updatedLog.updated_links} updated`);
            } else if (updatedLog.status === 'failed') {
              toast.error(`Sync failed: ${updatedLog.error_message}`);
            }
          }
        }
      )
      .subscribe();

    // Cleanup subscriptions on unmount
    return () => {
      if (redirectsChannelRef.current) {
        supabase.removeChannel(redirectsChannelRef.current);
      }
      if (syncLogsChannelRef.current) {
        supabase.removeChannel(syncLogsChannelRef.current);
      }
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [shortIoDomain, loadData]);

  // Poll sync progress
  const startPollingProgress = useCallback((syncLogId: string, type: ActiveSync['type']) => {
    // Clear any existing poll
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    // Initial state
    setActiveSync({ syncLogId, type, total: 0, processed: 0, updated: 0 });
    lastReloadAtRef.current = 0; // Reset reload milestone tracker

    const pollProgress = async () => {
      try {
        // Add timestamp to avoid any potential caching
        const { data, error } = await supabase
          .from('redirects_sync_logs')
          .select('*')
          .eq('id', syncLogId)
          .single();

        console.log('[Poll]', new Date().toISOString(), 'syncLogId:', syncLogId, 'data:', data ? { status: data.status, new_links: data.new_links, total_links: data.total_links } : null, 'error:', error);

        if (error) {
          console.error('Error polling sync progress:', error);
          return;
        }

        if (data) {
          // For running syncs, new_links stores processed count, updated_links stores update count
          setActiveSync({
            syncLogId,
            type,
            total: data.total_links || 0,
            processed: data.new_links || 0,
            updated: data.updated_links || 0,
          });

          // For totals sync, periodically reload data to update the stats cards
          // This triggers every 100 processed links to show live totals
          if (type === 'totals' && data.status === 'running') {
            const processed = data.new_links || 0;
            const milestone = Math.floor(processed / 100) * 100;
            // Reload when we hit a new 100-link milestone (100, 200, 300, etc.)
            if (milestone > 0 && milestone > lastReloadAtRef.current) {
              console.log('[Poll] Reloading data at', milestone, 'processed links');
              lastReloadAtRef.current = milestone;
              loadDataRef.current?.();
            }
          }

          // Check if sync is complete
          if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }

            // Keep progress visible for a moment, then clear
            setTimeout(() => {
              setActiveSync(null);
              setCancelling(false);
              // Reset the syncing state based on type
              if (type === 'sync') setSyncing(false);
              else if (type === 'history') setSyncingHistory(false);
              else if (type === 'yesterday') setSyncingYesterday(false);
              else if (type === 'totals') setSyncingTotals(false);

              // Reload data to reflect changes
              loadDataRef.current?.();

              if (data.status === 'completed') {
                toast.success(`Sync completed: ${data.updated_links || 0} links updated`);
              } else if (data.status === 'cancelled') {
                toast.info('Sync cancelled');
              } else {
                toast.error(`Sync failed: ${data.error_message || 'Unknown error'}`);
              }
            }, 1500);
          }
        }
      } catch (err) {
        console.error('Error polling sync progress:', err);
      }
    };

    // Poll immediately, then every 2 seconds
    console.log('[Polling] Starting polling for syncLogId:', syncLogId);
    pollProgress();
    pollIntervalRef.current = setInterval(() => {
      console.log('[Polling] Interval tick');
      pollProgress();
    }, 2000);
  }, []); // No dependencies - uses refs for callbacks

  // Store ref for use in loadData
  startPollingProgressRef.current = startPollingProgress;

  // Cancel a running sync
  const handleCancelSync = async () => {
    if (!activeSync) return;

    setCancelling(true);
    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/redirects/sync-cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ syncLogId: activeSync.syncLogId, domain: shortIoDomain }),
      });

      if (!response.ok) {
        throw new Error('Cancel failed');
      }

      toast.info('Sync cancelled');

      // Clear polling and UI immediately
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }

      // Reset UI state
      setActiveSync(null);
      setCancelling(false);
      setSyncing(false);
      setSyncingHistory(false);
      setSyncingYesterday(false);
      setSyncingTotals(false);

      // Reload data
      loadData();
    } catch (error) {
      console.error('Error cancelling sync:', error);
      toast.error('Failed to cancel sync');
      setCancelling(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      // Call the API endpoint to sync Short.io data
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/redirects/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ domain: shortIoDomain }),
      });

      if (!response.ok) {
        throw new Error('Sync failed');
      }

      const result = await response.json();
      if (result.syncLogId) {
        toast.success('Sync started - tracking progress...');
        startPollingProgress(result.syncLogId, 'sync');
      } else {
        toast.success('Sync started');
        setSyncing(false);
      }
    } catch (error) {
      console.error('Error syncing:', error);
      toast.error('Failed to start sync. Make sure the API server is running.');
      setSyncing(false);
    }
  };

  const handleSyncHistory = async () => {
    setSyncingHistory(true);
    try {
      // Call the API endpoint to sync historical click data (past year)
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/redirects/sync-history`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ domain: shortIoDomain, daysBack: 365 }),
      });

      if (!response.ok) {
        throw new Error('History sync failed');
      }

      const result = await response.json();
      if (result.syncLogId) {
        toast.success('Historical sync started - tracking progress...');
        startPollingProgress(result.syncLogId, 'history');
      } else {
        toast.success('Historical sync started');
        setSyncingHistory(false);
      }
    } catch (error) {
      console.error('Error syncing history:', error);
      toast.error('Failed to start history sync. Make sure the API server is running.');
      setSyncingHistory(false);
    }
  };

  const handleSyncYesterday = async () => {
    setSyncingYesterday(true);
    try {
      // Call the API endpoint to sync yesterday's click data
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/redirects/sync-yesterday`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ domain: shortIoDomain }),
      });

      if (!response.ok) {
        throw new Error('Yesterday sync failed');
      }

      const result = await response.json();
      if (result.syncLogId) {
        toast.success('Yesterday sync started - tracking progress...');
        startPollingProgress(result.syncLogId, 'yesterday');
      } else {
        toast.success('Yesterday sync started');
        setSyncingYesterday(false);
      }
    } catch (error) {
      console.error('Error syncing yesterday:', error);
      toast.error('Failed to start yesterday sync. Make sure the API server is running.');
      setSyncingYesterday(false);
    }
  };

  const handleSyncTotals = async () => {
    setSyncingTotals(true);
    try {
      // Call the API endpoint to sync total click counts (fast - no daily breakdown)
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/redirects/sync-totals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ domain: shortIoDomain }),
      });

      if (!response.ok) {
        throw new Error('Totals sync failed');
      }

      const result = await response.json();
      if (result.syncLogId) {
        toast.success('Totals sync started - tracking progress...');
        startPollingProgress(result.syncLogId, 'totals');
      } else {
        toast.success('Totals sync started');
        setSyncingTotals(false);
      }
    } catch (error) {
      console.error('Error syncing totals:', error);
      toast.error('Failed to start totals sync. Make sure the API server is running.');
      setSyncingTotals(false);
    }
  };

  const handleParse = async () => {
    setParsing(true);
    try {
      // Call the API endpoint to re-parse all redirect paths
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/redirects/parse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ domain: shortIoDomain, forceReparse: true }),
      });

      if (!response.ok) {
        throw new Error('Parse failed');
      }

      const result = await response.json();
      const stats = result.stats || result;
      toast.success(`Parsed ${stats.parsed || 0} redirects (${stats.needsReview || 0} need review)`);
      // Reload data to reflect new parsed metadata
      loadData();
    } catch (error) {
      console.error('Error parsing:', error);
      toast.error('Failed to parse redirects. Make sure the API server is running.');
    } finally {
      setParsing(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'Never';
    return new Date(dateString).toLocaleDateString();
  };

  // Edit functions for categorization
  const startEditingRedirect = (redirect: Redirect) => {
    setEditingRedirectId(redirect.id);
    setEditLinkCategory(redirect.link_category || '');
    setEditContentType(redirect.content_type || '');
    setEditContentNumber(redirect.content_number?.toString() || '');
    setEditNewsletterDate(redirect.newsletter_date || '');
    setEditDistributionChannel(redirect.distribution_channel || '');
  };

  const cancelEditingRedirect = () => {
    setEditingRedirectId(null);
    setEditLinkCategory('');
    setEditContentType('');
    setEditContentNumber('');
    setEditNewsletterDate('');
    setEditDistributionChannel('');
  };

  const saveRedirectCategory = async (redirectId: string) => {
    setSavingEdit(true);
    try {
      const updateData: Record<string, any> = {
        link_category: editLinkCategory || null,
        content_type: editContentType || null,
        content_number: editContentNumber ? parseInt(editContentNumber, 10) : null,
        newsletter_date: editNewsletterDate || null,
        distribution_channel: editDistributionChannel || null,
      };

      const { error } = await supabase
        .from('redirects')
        .update(updateData)
        .eq('id', redirectId);

      if (error) throw error;

      // Update local state
      setRedirects((prev) =>
        prev.map((r) =>
          r.id === redirectId
            ? { ...r, ...updateData }
            : r
        )
      );

      toast.success('Redirect updated successfully');
      cancelEditingRedirect();
    } catch (error) {
      console.error('Error saving redirect:', error);
      toast.error('Failed to save redirect');
    } finally {
      setSavingEdit(false);
    }
  };

  const columns = useMemo(
    () => [
      columnHelper.accessor('path', {
        header: 'Short Link',
        cell: (info) => {
          const row = info.row.original;
          const shortUrl = row.secure_short_url || row.short_url;
          return (
            <div className="flex items-center gap-2">
              <div className="flex flex-col">
                <span className="font-mono text-sm font-medium text-[var(--accent-11)]">
                  /{info.getValue()}
                </span>
                <span className="text-xs text-[var(--gray-11)] truncate max-w-[200px]">
                  {shortUrl}
                </span>
              </div>
              <div className="flex gap-1">
                <Button isIcon variant="ghost" onClick={() => copyToClipboard(shortUrl)} title="Copy short URL">
                  <ClipboardDocumentIcon className="h-4 w-4" />
                </Button>
                <a
                  href={shortUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1 hover:bg-[var(--gray-a3)] rounded"
                  title="Open short URL"
                >
                  <ArrowTopRightOnSquareIcon className="h-4 w-4 text-[var(--gray-a8)]" />
                </a>
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor('original_url', {
        header: 'Destination',
        cell: (info) => (
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--gray-12)] truncate max-w-[300px]" title={info.getValue()}>
              {info.getValue()}
            </span>
            <a
              href={info.getValue()}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1 hover:bg-[var(--gray-a3)] rounded flex-shrink-0"
              title="Open destination"
            >
              <ArrowTopRightOnSquareIcon className="h-4 w-4 text-[var(--gray-a8)]" />
            </a>
          </div>
        ),
      }),
      columnHelper.accessor('last_totals_synced_at', {
        header: 'Last Synced',
        cell: (info) => {
          const value = info.getValue();
          if (!value) return <span className="text-[var(--gray-a8)]">Never</span>;
          const date = new Date(value);
          const now = new Date();
          const diffMs = now.getTime() - date.getTime();
          const diffMins = Math.floor(diffMs / 60000);
          const diffHours = Math.floor(diffMs / 3600000);
          const diffDays = Math.floor(diffMs / 86400000);
          let relativeTime: string;
          if (diffMins < 1) {
            relativeTime = 'Just now';
          } else if (diffMins < 60) {
            relativeTime = `${diffMins}m ago`;
          } else if (diffHours < 24) {
            relativeTime = `${diffHours}h ago`;
          } else {
            relativeTime = `${diffDays}d ago`;
          }
          return (
            <span className="text-sm text-[var(--gray-11)]" title={date.toLocaleString()}>
              {relativeTime}
            </span>
          );
        },
      }),
      columnHelper.accessor('total_clicks', {
        header: 'Clicks',
        cell: (info) => {
          const row = info.row.original;
          const botClicks = (row.total_clicks || 0) - (row.human_clicks || 0);
          return (
            <div className="flex flex-col">
              <span className="font-medium">{info.getValue().toLocaleString()} total</span>
              <span className="text-xs text-[var(--green-11)]">
                {(row.human_clicks || 0).toLocaleString()} human
              </span>
              <span className="text-xs text-[var(--yellow-11)]">
                {botClicks.toLocaleString()} bot
              </span>
            </div>
          );
        },
      }),
      columnHelper.accessor('link_category', {
        header: 'Category',
        cell: (info) => {
          const row = info.row.original;
          const isEditing = editingRedirectId === row.id;
          const category = info.getValue();

          if (isEditing) {
            return (
              <select
                value={editLinkCategory}
                onChange={(e) => setEditLinkCategory(e.target.value)}
                className="block w-full rounded border-[var(--gray-a6)] bg-[var(--color-background)] text-[var(--gray-12)] text-xs py-1 px-1.5"
              >
                <option value="">None</option>
                {LINK_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            );
          }

          if (!category) return <span className="text-[var(--gray-a8)] text-xs">-</span>;
          return (
            <Badge color="info" variant="soft" className="text-xs">
              {category}
            </Badge>
          );
        },
      }),
      columnHelper.accessor('content_type', {
        header: 'Content Type',
        cell: (info) => {
          const row = info.row.original;
          const isEditing = editingRedirectId === row.id;
          const contentType = info.getValue();
          const color = CONTENT_TYPE_COLORS[contentType || ''] || '#6B7280';

          if (isEditing) {
            return (
              <div className="flex items-center gap-1">
                <select
                  value={editContentType}
                  onChange={(e) => setEditContentType(e.target.value)}
                  className="block w-20 rounded border-[var(--gray-a6)] bg-[var(--color-background)] text-[var(--gray-12)] text-xs py-1 px-1"
                >
                  <option value="">None</option>
                  {CONTENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  value={editContentNumber}
                  onChange={(e) => setEditContentNumber(e.target.value)}
                  placeholder="#"
                  min="1"
                  className="block w-10 rounded border-[var(--gray-a6)] bg-[var(--color-background)] text-[var(--gray-12)] text-xs py-1 px-1 text-center"
                />
              </div>
            );
          }

          if (!contentType) return <span className="text-[var(--gray-a8)] text-xs">-</span>;
          return (
            <Badge variant="soft" className="text-xs">
              <span
                className="w-1.5 h-1.5 rounded-full inline-block"
                style={{ backgroundColor: color }}
              />
              {contentType.replace(/_/g, ' ')}
              {row.content_number && (
                <span className="opacity-75">#{row.content_number}</span>
              )}
            </Badge>
          );
        },
      }),
      columnHelper.accessor('newsletter_date', {
        header: 'Newsletter',
        cell: (info) => {
          const row = info.row.original;
          const isEditing = editingRedirectId === row.id;
          const date = info.getValue();

          if (isEditing) {
            return (
              <div className="flex items-center gap-1">
                <Flatpickr
                  defaultValue={editNewsletterDate || ''}
                  onChange={(dates) => {
                    if (dates && dates.length > 0) {
                      const d = dates[0];
                      const year = d.getFullYear();
                      const month = String(d.getMonth() + 1).padStart(2, '0');
                      const day = String(d.getDate()).padStart(2, '0');
                      setEditNewsletterDate(`${year}-${month}-${day}`);
                    } else {
                      setEditNewsletterDate('');
                    }
                  }}
                  options={{
                    dateFormat: 'Y-m-d',
                    allowInput: true,
                  }}
                  placeholder="Select date"
                  className="w-24 text-xs rounded border-[var(--gray-a6)] bg-[var(--color-background)] text-[var(--gray-12)] py-1 px-1 cursor-pointer"
                />
                {editNewsletterDate && (
                  <Button
                    isIcon
                    variant="ghost"
                    type="button"
                    onClick={() => setEditNewsletterDate('')}
                    title="Clear date"
                  >
                    <XMarkIcon className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            );
          }

          if (!date) return <span className="text-[var(--gray-a8)] text-xs">-</span>;
          return (
            <span className="text-xs text-[var(--gray-11)]">
              {new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          );
        },
      }),
      columnHelper.display({
        id: 'edit_actions',
        header: 'Edit',
        cell: (info) => {
          const row = info.row.original;
          const isEditing = editingRedirectId === row.id;

          if (isEditing) {
            return (
              <div className="flex items-center gap-1">
                <Button
                  isIcon
                  variant="ghost"
                  color="green"
                  onClick={() => saveRedirectCategory(row.id)}
                  disabled={savingEdit}
                  title="Save"
                >
                  <CheckIcon className="h-4 w-4" />
                </Button>
                <Button
                  isIcon
                  variant="ghost"
                  onClick={cancelEditingRedirect}
                  disabled={savingEdit}
                  title="Cancel"
                >
                  <XMarkIcon className="h-4 w-4" />
                </Button>
              </div>
            );
          }

          return (
            <Button
              isIcon
              variant="ghost"
              onClick={() => startEditingRedirect(row)}
              title="Edit categorization"
            >
              <PencilIcon className="h-4 w-4" />
            </Button>
          );
        },
      }),
      columnHelper.accessor('archived', {
        header: 'Status',
        cell: (info) => (
          <Badge color={info.getValue() ? 'warning' : 'success'} variant="soft">
            {info.getValue() ? 'Archived' : 'Active'}
          </Badge>
        ),
      }),
      columnHelper.accessor('tags', {
        header: 'Tags',
        cell: (info) => {
          const tags = info.getValue();
          if (!tags || tags.length === 0) return <span className="text-[var(--gray-a8)]">-</span>;
          return (
            <div className="flex flex-wrap gap-1">
              {tags.slice(0, 3).map((tag, i) => (
                <Badge key={i} color="secondary" variant="soft" className="text-xs">
                  {tag}
                </Badge>
              ))}
              {tags.length > 3 && (
                <Badge color="secondary" variant="soft" className="text-xs">
                  +{tags.length - 3}
                </Badge>
              )}
            </div>
          );
        },
      }),
      columnHelper.accessor('shortio_created_at', {
        header: 'Created',
        cell: (info) => (
          <span className="text-sm text-[var(--gray-11)]">
            {formatDate(info.getValue())}
          </span>
        ),
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        cell: (info) => (
          <RowActions actions={[
            {
              label: 'Details',
              icon: <EyeIcon className="size-4" />,
              onClick: () => navigate(`/admin/redirects/${info.row.original.id}/detail`),
            },
          ]} />
        ),
      }),
    ],
    [navigate, editingRedirectId, editLinkCategory, editContentType, editContentNumber, editNewsletterDate, savingEdit]
  );

  // Compute live stats from redirects array - updates in realtime as traffic syncs
  const liveStats = useMemo(() => {
    const totalLinks = redirects.length;
    const activeLinks = redirects.filter(r => !r.archived).length;
    const totalClicks = redirects.reduce((sum, r) => sum + (r.total_clicks || 0), 0);
    const uniqueClicks = redirects.reduce((sum, r) => sum + (r.unique_clicks || 0), 0);
    const humanClicks = redirects.reduce((sum, r) => sum + (r.human_clicks || 0), 0);
    const botClicks = totalClicks - humanClicks;

    return {
      total_redirects: totalLinks,
      active_redirects: activeLinks,
      total_clicks: totalClicks,
      unique_clicks: uniqueClicks,
      human_clicks: humanClicks,
      bot_clicks: botClicks,
    };
  }, [redirects]);

  const table = useReactTable({
    data: redirects,
    columns,
    state: {
      sorting,
      globalFilter,
      pagination,
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  if (loading) {
    return (
      <Page title="Redirects">
        <div className="p-6 animate-pulse">
          <div className="h-8 bg-[var(--gray-a3)] rounded mb-6 w-48"></div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-24 bg-[var(--gray-a3)] rounded"></div>
            ))}
          </div>
          <div className="h-96 bg-[var(--gray-a3)] rounded"></div>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Redirects">
      <div className="p-6">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold mb-2 text-[var(--gray-12)]">
                URL Redirects
              </h1>
              <p className="text-[var(--gray-11)]">
                Manage Short.io shortened URLs for{' '}
                <span className="font-mono text-[var(--accent-11)]">{shortIoDomain}</span>
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={handleSync}
                disabled={syncing || syncingHistory || syncingYesterday || syncingTotals}
                color="primary"
                className="gap-2"
              >
                <ArrowPathIcon className={`size-4 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? 'Syncing...' : 'Sync Links'}
              </Button>
              <Button
                onClick={handleSyncTotals}
                disabled={syncing || syncingHistory || syncingYesterday || syncingTotals || redirects.length === 0}
                variant="outlined"
                className="gap-2"
                title="Fetch total/human/unique click counts for all links (fast)"
              >
                <ChartBarIcon className={`size-4 ${syncingTotals ? 'animate-pulse' : ''}`} />
                {syncingTotals ? 'Syncing...' : 'Sync Totals'}
              </Button>
              <Button
                onClick={handleSyncYesterday}
                disabled={syncing || syncingHistory || syncingYesterday || syncingTotals || redirects.length === 0}
                variant="outlined"
                className="gap-2"
                title="Fetch click data for yesterday only"
              >
                <CalendarIcon className={`size-4 ${syncingYesterday ? 'animate-pulse' : ''}`} />
                {syncingYesterday ? 'Syncing...' : 'Sync Yesterday'}
              </Button>
              <Button
                onClick={handleSyncHistory}
                disabled={syncing || syncingHistory || syncingYesterday || syncingTotals || redirects.length === 0}
                variant="outlined"
                className="gap-2"
                title="Fetch daily click history for the past year"
              >
                <CalendarIcon className={`size-4 ${syncingHistory ? 'animate-pulse' : ''}`} />
                {syncingHistory ? 'Syncing...' : 'Sync History'}
              </Button>
              <Button
                onClick={handleParse}
                disabled={syncing || syncingHistory || syncingYesterday || syncingTotals || parsing || redirects.length === 0}
                variant="outlined"
                className="gap-2"
                title="Re-parse all redirect paths to extract metadata (content type, date, etc.)"
              >
                <DocumentMagnifyingGlassIcon className={`size-4 ${parsing ? 'animate-pulse' : ''}`} />
                {parsing ? 'Parsing...' : 'Re-parse'}
              </Button>
            </div>
          </div>
        </div>

        {/* Sync Progress Bar */}
        {activeSync && (
          <Card skin="bordered" className="mb-6 p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <ArrowPathIcon className="size-4 animate-spin text-[var(--accent-11)]" />
                <span className="font-medium text-[var(--gray-12)]">
                  {activeSync.type === 'sync' && 'Syncing Links'}
                  {activeSync.type === 'totals' && 'Syncing Totals'}
                  {activeSync.type === 'history' && 'Syncing History'}
                  {activeSync.type === 'yesterday' && 'Syncing Yesterday'}
                </span>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-sm text-[var(--gray-11)]">
                  {activeSync.processed.toLocaleString()} / {activeSync.total.toLocaleString()} links
                  {activeSync.updated > 0 && (
                    <span className="ml-2 text-[var(--green-11)]">
                      ({activeSync.updated.toLocaleString()} updated)
                    </span>
                  )}
                </div>
                <Button
                  variant="ghost"
                  color="red"
                  onClick={handleCancelSync}
                  disabled={cancelling}
                  title="Cancel sync"
                >
                  <XMarkIcon className="size-4" />
                  {cancelling ? 'Cancelling...' : 'Cancel'}
                </Button>
              </div>
            </div>
            <div className="w-full bg-[var(--gray-a3)] rounded-full h-2.5 overflow-hidden">
              <div
                className="bg-[var(--accent-9)] h-2.5 rounded-full transition-all duration-300 ease-out"
                style={{
                  width: activeSync.total > 0
                    ? `${Math.min(100, (activeSync.processed / activeSync.total) * 100)}%`
                    : '0%'
                }}
              />
            </div>
            {activeSync.total > 0 && (
              <div className="text-xs text-[var(--gray-11)] mt-1 text-right">
                {Math.round((activeSync.processed / activeSync.total) * 100)}% complete
              </div>
            )}
          </Card>
        )}

        {/* Stats Cards - Uses liveStats computed from redirects for realtime updates */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-6 mb-8">
          <Card variant="surface" className="p-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-[var(--accent-a3)] rounded-lg">
                <LinkIcon className="h-5 w-5 text-[var(--accent-11)]" />
              </div>
              <div>
                <div className="text-sm font-medium text-[var(--gray-11)]">Total Links</div>
                <div className="text-2xl font-bold">{liveStats.total_redirects.toLocaleString()}</div>
                <div className="text-xs text-[var(--gray-a8)]">{liveStats.active_redirects.toLocaleString()} active</div>
              </div>
            </div>
          </Card>
          <Card variant="surface" className={`p-6 ${activeSync?.type === 'totals' ? 'ring-2 ring-[var(--blue-a6)]' : ''}`}>
            <div className="flex items-center gap-3">
              <div className={`p-2 bg-[var(--blue-a3)] rounded-lg ${activeSync?.type === 'totals' ? 'animate-pulse' : ''}`}>
                <ChartBarIcon className="h-5 w-5 text-[var(--blue-11)]" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--gray-11)]">Total Clicks</span>
                  {activeSync?.type === 'totals' && (
                    <span className="text-xs text-[var(--blue-11)] animate-pulse">updating...</span>
                  )}
                </div>
                <div className="text-2xl font-bold text-[var(--blue-11)] transition-all duration-300">
                  {liveStats.total_clicks.toLocaleString()}
                </div>
              </div>
            </div>
          </Card>
          <Card variant="surface" className={`p-6 ${activeSync?.type === 'totals' ? 'ring-2 ring-[var(--green-a6)]' : ''}`}>
            <div className="flex items-center gap-3">
              <div className={`p-2 bg-[var(--green-a3)] rounded-lg ${activeSync?.type === 'totals' ? 'animate-pulse' : ''}`}>
                <ChartBarIcon className="h-5 w-5 text-[var(--green-11)]" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--gray-11)]">Human Clicks</span>
                  {activeSync?.type === 'totals' && (
                    <span className="text-xs text-[var(--green-11)] animate-pulse">updating...</span>
                  )}
                </div>
                <div className="text-2xl font-bold text-[var(--green-11)] transition-all duration-300">
                  {liveStats.human_clicks.toLocaleString()}
                </div>
                <div className="text-xs text-[var(--gray-a8)]">
                  {liveStats.total_clicks > 0 ? ((liveStats.human_clicks / liveStats.total_clicks) * 100).toFixed(1) : 0}% of total
                </div>
              </div>
            </div>
          </Card>
          <Card variant="surface" className={`p-6 ${activeSync?.type === 'totals' ? 'ring-2 ring-[var(--yellow-a6)]' : ''}`}>
            <div className="flex items-center gap-3">
              <div className={`p-2 bg-[var(--yellow-a3)] rounded-lg ${activeSync?.type === 'totals' ? 'animate-pulse' : ''}`}>
                <ChartBarIcon className="h-5 w-5 text-[var(--yellow-11)]" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--gray-11)]">Bot Clicks</span>
                  {activeSync?.type === 'totals' && (
                    <span className="text-xs text-[var(--yellow-11)] animate-pulse">updating...</span>
                  )}
                </div>
                <div className="text-2xl font-bold text-[var(--yellow-11)] transition-all duration-300">
                  {liveStats.bot_clicks.toLocaleString()}
                </div>
                <div className="text-xs text-[var(--gray-a8)]">
                  {liveStats.total_clicks > 0 ? ((liveStats.bot_clicks / liveStats.total_clicks) * 100).toFixed(1) : 0}% of total
                </div>
              </div>
            </div>
          </Card>
          <Card variant="surface" className={`p-6 ${activeSync?.type === 'totals' ? 'ring-2 ring-[var(--purple-a6)]' : ''}`}>
            <div className="flex items-center gap-3">
              <div className={`p-2 bg-[var(--purple-a3)] rounded-lg ${activeSync?.type === 'totals' ? 'animate-pulse' : ''}`}>
                <ChartBarIcon className="h-5 w-5 text-[var(--purple-11)]" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--gray-11)]">Unique Clicks</span>
                  {activeSync?.type === 'totals' && (
                    <span className="text-xs text-[var(--purple-11)] animate-pulse">updating...</span>
                  )}
                </div>
                <div className="text-2xl font-bold text-[var(--purple-11)] transition-all duration-300">
                  {liveStats.unique_clicks.toLocaleString()}
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Search */}
        <div className="mb-6">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-[var(--gray-a8)]" />
            <input
              type="text"
              placeholder="Search redirects..."
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-[var(--gray-a6)] rounded-lg bg-[var(--color-background)] text-[var(--gray-12)] focus:ring-2 focus:ring-[var(--accent-a6)] focus:border-[var(--accent-a6)]"
            />
          </div>
        </div>

        {/* Table */}
        <DataTable table={table} loading={loading} onRowDoubleClick={(redirect) => navigate(`/admin/redirects/${redirect.id}/detail`)} />

        {/* Recent Sync Logs */}
        {syncLogs.length > 0 && (
          <Card variant="surface" className="mt-8 overflow-hidden">
            <div className="px-6 py-4 border-b border-[var(--gray-a6)]">
              <h3 className="text-lg font-medium">Recent Sync Activity</h3>
            </div>
            <div className="divide-y divide-[var(--gray-a6)]">
              {syncLogs.map((log) => (
                <div key={log.id} className="px-6 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <Badge
                      color={
                        log.status === 'completed'
                          ? 'success'
                          : log.status === 'failed'
                          ? 'error'
                          : log.status === 'running'
                          ? 'warning'
                          : 'secondary'
                      }
                      variant="soft"
                    >
                      {log.status}
                    </Badge>
                    <div>
                      <div className="text-sm font-medium">
                        {log.new_links} new, {log.updated_links} updated
                      </div>
                      <div className="text-xs text-[var(--gray-11)]">
                        {new Date(log.started_at).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  {log.error_message && (
                    <span className="text-sm text-[var(--red-11)]">{log.error_message}</span>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
}
