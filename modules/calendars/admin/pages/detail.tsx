import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  ArrowLeftIcon,
  CalendarIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Button, Card, Badge, Tabs } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { CalendarService, Calendar, CalendarStats } from '@/lib/services/calendarService';
import { CalendarOverviewTab } from '@/components/calendars/CalendarOverviewTab';
import { CalendarEventsTab } from '@/components/calendars/CalendarEventsTab';
import { CalendarMembersTab } from '@/components/calendars/CalendarMembersTab';
import { CalendarScrapersTab } from '@/components/calendars/CalendarScrapersTab';
import { CalendarPermissionsTab } from '@/components/calendars/CalendarPermissionsTab';
import { CalendarSettingsTab } from '@/components/calendars/CalendarSettingsTab';
// Import cancel utility to make it available in browser console
import '@/utils/cancelStuckImports';

export default function CalendarDetailPage() {
  const { calendarId, tab } = useParams<{ calendarId: string; tab?: string }>();
  const navigate = useNavigate();

  const [calendar, setCalendar] = useState<Calendar | null>(null);
  const [stats, setStats] = useState<CalendarStats | null>(null);
  const [loading, setLoading] = useState(true);

  // Define valid tabs
  const validTabs = ['overview', 'events', 'people', 'scrapers', 'permissions', 'settings'] as const;
  type TabType = typeof validTabs[number];
  const activeTab: TabType = (tab && validTabs.includes(tab as TabType)) ? tab as TabType : 'overview';

  // Helper function to navigate to a tab
  const navigateToTab = (newTab: TabType) => {
    navigate(`/calendars/${calendarId}/${newTab}`);
  };

  useEffect(() => {
    if (!calendarId) {
      toast.error('No calendar ID provided');
      navigate('/calendars');
      return;
    }

    loadCalendar();
  }, [calendarId]);

  const loadCalendar = async () => {
    if (!calendarId) return;

    setLoading(true);
    try {
      const [calendarResult, statsResult] = await Promise.all([
        CalendarService.getCalendarById(calendarId),
        CalendarService.getCalendarStats(calendarId),
      ]);

      if (!calendarResult.success || !calendarResult.data) {
        toast.error(calendarResult.error || 'Calendar not found');
        navigate('/calendars');
        return;
      }

      setCalendar(calendarResult.data);

      if (statsResult.success && statsResult.data) {
        setStats(statsResult.data);
      }
    } catch (error) {
      console.error('Error loading calendar:', error);
      toast.error('Failed to load calendar');
      navigate('/calendars');
    } finally {
      setLoading(false);
    }
  };

  const tabs = [
    {
      id: 'overview' as TabType,
      label: 'Overview',
    },
    {
      id: 'events' as TabType,
      label: 'Events',
    },
    {
      id: 'people' as TabType,
      label: 'People',
    },
    {
      id: 'scrapers' as TabType,
      label: 'Scrapers',
    },
    {
      id: 'permissions' as TabType,
      label: 'Permissions',
    },
    {
      id: 'settings' as TabType,
      label: 'Settings',
    },
  ];

  if (loading) {
    return (
      <Page title="Loading...">
        <div className="flex justify-center items-center py-12">
          <LoadingSpinner size="large" />
        </div>
      </Page>
    );
  }

  if (!calendar) {
    return (
      <Page title="Not Found">
        <Card className="p-12 text-center">
          <p className="text-[var(--gray-11)] mb-4">
            Calendar not found
          </p>
          <Button onClick={() => navigate('/calendars')}>
            Back to Calendars
          </Button>
        </Card>
      </Page>
    );
  }

  return (
    <Page>
      {/* Hero Section */}
      <div className="relative h-48 md:h-56 lg:h-64 overflow-hidden bg-gray-900 -mx-(--margin-x) -mt-(--margin-x)">
        {/* Background Image or Gradient */}
        {calendar.coverImageUrl ? (
          <img
            src={calendar.coverImageUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover object-center blur-[10px] scale-105"
          />
        ) : (
          <div
            className="absolute inset-0"
            style={{
              background: `linear-gradient(135deg, ${calendar.color || '#3B82F6'} 0%, ${adjustColor(calendar.color || '#3B82F6', -40)} 100%)`,
            }}
          />
        )}

        {/* Gradient Overlay for text readability */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-black/20" />

        {/* Back Button */}
        <div className="absolute top-6 z-10" style={{ left: 'calc(var(--margin-x) + 1.5rem)' }}>
          <button
            onClick={() => navigate('/calendars')}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-white/90 backdrop-blur-md border border-white/40 text-gray-900 shadow-sm hover:bg-white transition-colors"
          >
            <ArrowLeftIcon className="size-4" />
            Back
          </button>
        </div>

        {/* Calendar Title and Info */}
        <div className="absolute bottom-0 left-0 right-0" style={{ padding: '0 calc(var(--margin-x) + 1.5rem) 1.5rem' }}>
          <div className="flex items-center gap-3 mb-2">
            {calendar.logoUrl && (
              <img
                src={calendar.logoUrl}
                alt={calendar.name}
                className="w-12 h-12 rounded-lg object-cover bg-white/10"
              />
            )}
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl md:text-3xl lg:text-4xl font-bold text-white drop-shadow-lg">
                  {calendar.name}
                </h1>
                <Badge color={calendar.isActive ? 'success' : 'neutral'} className="text-sm">
                  {calendar.isActive ? 'Active' : 'Inactive'}
                </Badge>
                <Badge
                  color={
                    calendar.visibility === 'public' ? 'success' :
                    calendar.visibility === 'unlisted' ? 'warning' : 'neutral'
                  }
                  className="text-sm"
                >
                  {calendar.visibility}
                </Badge>
              </div>
              {calendar.description && (
                <p className="text-white/80 text-sm mt-1 max-w-2xl">
                  {calendar.description}
                </p>
              )}
            </div>
          </div>

          {/* Stats Row */}
          {stats && (
            <div className="flex items-center gap-6 text-sm text-white/90 flex-wrap mt-3">
              <div className="flex items-center gap-1.5">
                <CalendarIcon className="w-4 h-4" />
                <span>{stats.total_events} events</span>
                {stats.upcoming_events > 0 && (
                  <span className="text-white/60">({stats.upcoming_events} upcoming)</span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <UserGroupIcon className="w-4 h-4" />
                <span>{stats.total_members} members</span>
              </div>
              {stats.total_registered > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold">{stats.total_registered} registered</span>
                </div>
              )}
              {stats.total_attended > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold">{stats.total_attended} attended</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="-mx-(--margin-x)">
        <Tabs
          fullWidth
          value={activeTab}
          onChange={(tab) => navigateToTab(tab as TabType)}
          tabs={tabs}
        />
      </div>

      <div className="p-6 space-y-6">

        {/* Tab Content */}
        {activeTab === 'overview' && (
          <CalendarOverviewTab calendar={calendar} stats={stats} onRefresh={loadCalendar} />
        )}
        {activeTab === 'events' && (
          <CalendarEventsTab calendar={calendar} onRefresh={loadCalendar} />
        )}
        {activeTab === 'people' && (
          <CalendarMembersTab calendar={calendar} />
        )}
        {activeTab === 'scrapers' && (
          <CalendarScrapersTab calendar={calendar} onUpdate={loadCalendar} />
        )}
        {activeTab === 'permissions' && (
          <CalendarPermissionsTab calendar={calendar} />
        )}
        {activeTab === 'settings' && (
          <CalendarSettingsTab calendar={calendar} onUpdate={loadCalendar} />
        )}
      </div>
    </Page>
  );
}

// Helper function to darken a hex color
function adjustColor(hex: string, percent: number): string {
  // Remove # if present
  hex = hex.replace('#', '');

  // Parse RGB values
  let r = parseInt(hex.substring(0, 2), 16);
  let g = parseInt(hex.substring(2, 4), 16);
  let b = parseInt(hex.substring(4, 6), 16);

  // Adjust each value
  r = Math.max(0, Math.min(255, r + (r * percent / 100)));
  g = Math.max(0, Math.min(255, g + (g * percent / 100)));
  b = Math.max(0, Math.min(255, b + (b * percent / 100)));

  // Convert back to hex
  return `#${Math.round(r).toString(16).padStart(2, '0')}${Math.round(g).toString(16).padStart(2, '0')}${Math.round(b).toString(16).padStart(2, '0')}`;
}
