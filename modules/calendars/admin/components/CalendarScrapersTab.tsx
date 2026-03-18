import { useState, useEffect } from 'react';
import {
  PlusIcon,
  TrashIcon,
  ArrowPathIcon,
  CpuChipIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  ArrowDownTrayIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  Card,
  Button,
  Modal,
  Badge,
} from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Calendar, CalendarService } from '@/lib/services/calendarService';
import { ScraperService } from '@/utils/scraperService';
import type { Scraper } from '@/utils/scraperService';

interface CalendarScrapersTabProps {
  calendar: Calendar;
  onUpdate: () => void;
}

interface ScraperCalendarAssociation {
  id: string;
  scraper_id: number;
  calendar_id: string;
  is_primary: boolean;
  auto_add_events: boolean;
  is_active: boolean;
  created_at: string;
  scrapers: {
    id: number;
    name: string;
    description?: string;
    enabled: boolean;
    last_run?: string;
  };
}

function timeAgo(dateString: string | undefined): string {
  if (!dateString) return 'Never';

  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  const intervals = {
    year: 31536000,
    month: 2592000,
    week: 604800,
    day: 86400,
    hour: 3600,
    minute: 60,
  };

  for (const [unit, secondsInUnit] of Object.entries(intervals)) {
    const interval = Math.floor(seconds / secondsInUnit);
    if (interval >= 1) {
      return `${interval} ${unit}${interval === 1 ? '' : 's'} ago`;
    }
  }

  return 'just now';
}

export function CalendarScrapersTab({ calendar, onUpdate }: CalendarScrapersTabProps) {
  const [associations, setAssociations] = useState<ScraperCalendarAssociation[]>([]);
  const [allScrapers, setAllScrapers] = useState<Scraper[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selectedScraperId, setSelectedScraperId] = useState<number | null>(null);

  const loadAssociations = async () => {
    try {
      setLoading(true);
      const result = await CalendarService.getCalendarScrapers(calendar.id);

      if (result.success && result.data) {
        setAssociations(result.data as ScraperCalendarAssociation[]);
      } else {
        toast.error(result.error || 'Failed to load scrapers');
      }
    } catch (error) {
      console.error('Error loading scrapers:', error);
      toast.error('Failed to load scrapers');
    } finally {
      setLoading(false);
    }
  };

  const loadAllScrapers = async () => {
    try {
      const result = await ScraperService.getAllScrapers();
      if (result.data) {
        setAllScrapers(result.data);
      }
    } catch (error) {
      console.error('Error loading all scrapers:', error);
    }
  };

  useEffect(() => {
    loadAssociations();
    loadAllScrapers();
  }, [calendar.id]);

  const handleAddScraper = async () => {
    if (!selectedScraperId) return;

    try {
      setAdding(true);
      const result = await CalendarService.addScraperToCalendar(calendar.id, selectedScraperId, true);

      if (result.success) {
        toast.success('Scraper added to calendar');
        setShowAddModal(false);
        setSelectedScraperId(null);
        loadAssociations();
        onUpdate();
      } else {
        toast.error(result.error || 'Failed to add scraper');
      }
    } catch (error) {
      console.error('Error adding scraper:', error);
      toast.error('Failed to add scraper');
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveScraper = async (scraperId: number) => {
    try {
      const result = await CalendarService.removeScraperFromCalendar(calendar.id, scraperId);

      if (result.success) {
        toast.success('Scraper removed from calendar');
        loadAssociations();
        onUpdate();
      } else {
        toast.error(result.error || 'Failed to remove scraper');
      }
    } catch (error) {
      console.error('Error removing scraper:', error);
      toast.error('Failed to remove scraper');
    }
  };

  const handleImportEvents = async (scraperId: number) => {
    try {
      const result = await CalendarService.importScraperEvents(calendar.id, scraperId);

      if (result.success) {
        toast.success(`Imported ${result.data?.imported || 0} events`);
        onUpdate();
      } else {
        toast.error(result.error || 'Failed to import events');
      }
    } catch (error) {
      console.error('Error importing events:', error);
      toast.error('Failed to import events');
    }
  };

  // Filter out scrapers that are already associated
  const associatedScraperIds = associations.map(a => a.scraper_id);
  const availableScrapers = allScrapers.filter(s => !associatedScraperIds.includes(s.id));

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="medium" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-lg font-semibold">Linked Scrapers</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Scrapers that automatically add events to this calendar
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outlined"
            onClick={loadAssociations}
            className="gap-2"
          >
            <ArrowPathIcon className="size-4" />
            Refresh
          </Button>
          <Button
            onClick={() => setShowAddModal(true)}
            className="gap-2"
            disabled={availableScrapers.length === 0}
          >
            <PlusIcon className="size-4" />
            Link Scraper
          </Button>
        </div>
      </div>

      {/* Info Card */}
      <Card skin="shadow" className="p-4 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800">
        <div className="flex gap-3">
          <CpuChipIcon className="size-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-blue-800 dark:text-blue-200">
            <p className="font-medium">How scraper linking works:</p>
            <ul className="list-disc list-inside mt-1 space-y-1 text-blue-700 dark:text-blue-300">
              <li>When a linked scraper finds new events, they're automatically added to this calendar</li>
              <li>Existing events from newly linked scrapers are also imported</li>
              <li>Unlinking a scraper doesn't remove already imported events</li>
            </ul>
          </div>
        </div>
      </Card>

      {/* Default Scraper */}
      {calendar.defaultScraperId && (
        <Card skin="shadow" className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-100 dark:bg-purple-900/30 rounded-lg">
                <CpuChipIcon className="size-5 text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {allScrapers.find(s => s.id === calendar.defaultScraperId)?.name || `Scraper #${calendar.defaultScraperId}`}
                  </span>
                  <Badge color="purple">Default</Badge>
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Set as default scraper in calendar settings
                </p>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Linked Scrapers List */}
      {associations.length === 0 ? (
        <Card skin="shadow" className="p-12 text-center">
          <CpuChipIcon className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
            No linked scrapers
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            Link scrapers to automatically import their events into this calendar.
          </p>
          <Button
            onClick={() => setShowAddModal(true)}
            className="mt-4 gap-2"
            disabled={availableScrapers.length === 0}
          >
            <PlusIcon className="size-4" />
            Link Your First Scraper
          </Button>
        </Card>
      ) : (
        <div className="space-y-3">
          {associations.map((assoc) => (
            <Card key={assoc.id} skin="shadow" className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${
                    assoc.scrapers.enabled
                      ? 'bg-green-100 dark:bg-green-900/30'
                      : 'bg-gray-100 dark:bg-gray-800'
                  }`}>
                    <CpuChipIcon className={`size-5 ${
                      assoc.scrapers.enabled
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-gray-400'
                    }`} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{assoc.scrapers.name}</span>
                      {assoc.scrapers.enabled ? (
                        <Badge color="success" className="gap-1">
                          <CheckCircleIcon className="size-3" />
                          Enabled
                        </Badge>
                      ) : (
                        <Badge color="neutral" className="gap-1">
                          <XCircleIcon className="size-3" />
                          Disabled
                        </Badge>
                      )}
                      {assoc.is_primary && (
                        <Badge color="info">Primary</Badge>
                      )}
                    </div>
                    {assoc.scrapers.description && (
                      <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                        {assoc.scrapers.description}
                      </p>
                    )}
                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                      <span className="flex items-center gap-1">
                        <ClockIcon className="size-3" />
                        Last run: {timeAgo(assoc.scrapers.last_run)}
                      </span>
                      <span>Linked: {timeAgo(assoc.created_at)}</span>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outlined"
                    onClick={() => handleImportEvents(assoc.scraper_id)}
                    className="gap-1"
                    title="Import all events from this scraper"
                  >
                    <ArrowDownTrayIcon className="size-4" />
                    Import
                  </Button>
                  <Button
                    variant="outlined"
                    onClick={() => handleRemoveScraper(assoc.scraper_id)}
                    className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-700 dark:hover:bg-red-900/20"
                  >
                    <TrashIcon className="size-4 mr-1" />
                    Unlink
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Add Scraper Modal */}
      <Modal
        isOpen={showAddModal}
        onClose={() => {
          setShowAddModal(false);
          setSelectedScraperId(null);
        }}
        title="Link Scraper to Calendar"
        footer={
          <div className="flex gap-3 justify-end p-4">
            <Button
              variant="outlined"
              onClick={() => {
                setShowAddModal(false);
                setSelectedScraperId(null);
              }}
              disabled={adding}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddScraper}
              disabled={adding || !selectedScraperId}
            >
              {adding ? 'Linking...' : 'Link Scraper'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Select a scraper to link. Events from this scraper will be automatically added to the calendar.
          </p>

          {availableScrapers.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <CpuChipIcon className="mx-auto h-12 w-12 text-gray-400" />
              <p className="mt-2">All scrapers are already linked to this calendar.</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {availableScrapers.map((scraper) => (
                <div
                  key={scraper.id}
                  onClick={() => setSelectedScraperId(scraper.id)}
                  className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                    selectedScraperId === scraper.id
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                      : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${
                      scraper.enabled
                        ? 'bg-green-100 dark:bg-green-900/30'
                        : 'bg-gray-100 dark:bg-gray-800'
                    }`}>
                      <CpuChipIcon className={`size-4 ${
                        scraper.enabled
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-gray-400'
                      }`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{scraper.name}</span>
                        {scraper.enabled ? (
                          <Badge color="success" className="text-xs">Enabled</Badge>
                        ) : (
                          <Badge color="neutral" className="text-xs">Disabled</Badge>
                        )}
                      </div>
                      {scraper.description && (
                        <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
                          {scraper.description}
                        </p>
                      )}
                      <p className="text-xs text-gray-400 mt-0.5">
                        {scraper.total_items_scraped.toLocaleString()} events scraped
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
