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
import { CohortService, Cohort } from '../lib';
import { CohortSettingsTab } from '../components/CohortSettingsTab';
import { CohortWeeksTab } from '../components/CohortWeeksTab';
import { CohortStudentsTab } from '../components/CohortStudentsTab';
import { CohortWaitlistTab } from '../components/CohortWaitlistTab';

export default function CohortDetailPage() {
  const { cohortId, tab } = useParams<{ cohortId: string; tab?: string }>();
  const navigate = useNavigate();

  const [cohort, setCohort] = useState<Cohort | null>(null);
  const [loading, setLoading] = useState(true);

  // Define valid tabs
  const validTabs = ['settings', 'weeks', 'students', 'waitlist'] as const;
  type TabType = typeof validTabs[number];
  const activeTab: TabType = (tab && validTabs.includes(tab as TabType)) ? tab as TabType : 'settings';

  // Helper function to navigate to a tab
  const navigateToTab = (newTab: TabType) => {
    navigate(`/cohorts/${cohortId}/${newTab}`);
  };

  useEffect(() => {
    if (!cohortId) {
      toast.error('No cohort ID provided');
      navigate('/cohorts/manage');
      return;
    }

    loadCohort();
  }, [cohortId]);

  const loadCohort = async () => {
    if (!cohortId) return;

    setLoading(true);
    try {
      const { data, error } = await CohortService.getCohort(cohortId);
      if (error) throw error;

      if (!data) {
        toast.error('Cohort not found');
        navigate('/cohorts/manage');
        return;
      }

      setCohort(data);
    } catch (error) {
      console.error('Error loading cohort:', error);
      toast.error('Failed to load cohort');
      navigate('/cohorts/manage');
    } finally {
      setLoading(false);
    }
  };

  const tabs = [
    {
      id: 'settings' as TabType,
      label: 'Settings',
    },
    {
      id: 'weeks' as TabType,
      label: 'Weeks',
    },
    {
      id: 'students' as TabType,
      label: 'Students',
    },
    {
      id: 'waitlist' as TabType,
      label: 'Waitlist',
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

  if (!cohort) {
    return (
      <Page title="Not Found">
        <Card className="p-12 text-center">
          <p className="text-[var(--gray-11)] mb-4">
            Cohort not found
          </p>
          <Button onClick={() => navigate('/cohorts/manage')}>
            Back to Cohorts
          </Button>
        </Card>
      </Page>
    );
  }

  return (
    <Page>
      {/* Hero Section */}
      <div className="relative h-48 md:h-56 lg:h-64 overflow-hidden bg-gray-900 -mx-(--margin-x) -mt-(--margin-x)">
        {/* Background Image */}
        {cohort.image ? (
          <img
            src={cohort.image}
            alt=""
            className="absolute inset-0 w-full h-full object-cover object-center blur-[10px] scale-105"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-primary-600 to-primary-800 dark:from-primary-800 dark:to-primary-950" />
        )}

        {/* Gradient Overlay for text readability */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-black/20" />

        {/* Back Button */}
        <div className="absolute top-6 z-10" style={{ left: 'calc(var(--margin-x) + 1.5rem)' }}>
          <button
            onClick={() => navigate('/cohorts/manage')}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-white/90 backdrop-blur-md border border-white/40 text-gray-900 shadow-sm hover:bg-white transition-colors"
          >
            <ArrowLeftIcon className="size-4" />
            Back
          </button>
        </div>

        {/* Cohort Title and Info */}
        <div className="absolute bottom-0 left-0 right-0" style={{ padding: '0 calc(var(--margin-x) + 1.5rem) 1.5rem' }}>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl md:text-3xl lg:text-4xl font-bold text-white drop-shadow-lg">
              {cohort.title}
            </h1>
            <Badge color={cohort.is_active ? 'success' : 'neutral'} className="text-sm">
              {cohort.is_active ? 'Active' : 'Inactive'}
            </Badge>
          </div>
          <div className="flex items-center gap-4 text-sm text-white/90 flex-wrap">
            {cohort.instructor_name && (
              <div className="flex items-center gap-1.5">
                <UserGroupIcon className="w-4 h-4" />
                <span>{cohort.instructor_name}</span>
              </div>
            )}
            {cohort.start_date && (
              <div className="flex items-center gap-1.5">
                <CalendarIcon className="w-4 h-4" />
                <span>
                  {new Date(cohort.start_date).toLocaleDateString('en-US', { dateStyle: 'medium' })} - {new Date(cohort.end_date).toLocaleDateString('en-US', { dateStyle: 'medium' })}
                </span>
              </div>
            )}
            {cohort.price_cents && (
              <div className="flex items-center gap-1.5">
                <span className="font-semibold">${(cohort.price_cents / 100).toFixed(0)}</span>
              </div>
            )}
          </div>
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
        {activeTab === 'settings' && (
          <CohortSettingsTab cohort={cohort} onUpdate={loadCohort} />
        )}
        {activeTab === 'weeks' && (
          <CohortWeeksTab cohort={cohort} />
        )}
        {activeTab === 'students' && (
          <CohortStudentsTab cohort={cohort} />
        )}
        {activeTab === 'waitlist' && (
          <CohortWaitlistTab cohort={cohort} />
        )}
      </div>
    </Page>
  );
}
