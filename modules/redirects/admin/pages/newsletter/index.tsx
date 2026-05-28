import { useParams, useNavigate } from 'react-router';
import {
  NewspaperIcon,
  ChartBarIcon,
  Cog6ToothIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { Tabs } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { NewsletterLeaderboardTab } from './NewsletterLeaderboardTab';
import { NewsletterTrendsTab } from './NewsletterTrendsTab';
import { ShortcodeConfigTab } from './ShortcodeConfigTab';
import { NeedsReviewTab } from './NeedsReviewTab';

type TabType = 'leaderboard' | 'trends' | 'config' | 'review';

const validTabs: TabType[] = ['leaderboard', 'trends', 'config', 'review'];

export default function NewsletterAnalyticsPage() {
  const { tab } = useParams<{ tab: string }>();
  const navigate = useNavigate();

  // Default to 'leaderboard' if tab is invalid or missing
  const activeTab: TabType = validTabs.includes(tab as TabType) ? (tab as TabType) : 'leaderboard';

  const handleTabChange = (newTab: TabType) => {
    navigate(`/admin/redirects/newsletter/${newTab}`);
  };

  const tabs = [
    { id: 'leaderboard' as TabType, label: 'Leaderboard', icon: ChartBarIcon },
    { id: 'trends' as TabType, label: 'Trends', icon: NewspaperIcon },
    { id: 'config' as TabType, label: 'Shortcode Config', icon: Cog6ToothIcon },
    { id: 'review' as TabType, label: 'Needs Review', icon: ExclamationTriangleIcon },
  ];

  return (
    <Page title="Newsletter Analytics">
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
            Newsletter Analytics
          </h1>
          <p className="text-[var(--gray-11)] mt-1">
            Track link performance, compare editions, and manage shortcode mappings
          </p>
        </div>

        {/* Tab Navigation */}
        <Tabs
          value={activeTab}
          onChange={(tab) => handleTabChange(tab as TabType)}
          tabs={tabs}
          className="mb-8"
        />

        {/* Tab Content */}
        <div className="animate-in fade-in duration-200">
          {activeTab === 'leaderboard' && <NewsletterLeaderboardTab />}
          {activeTab === 'trends' && <NewsletterTrendsTab />}
          {activeTab === 'config' && <ShortcodeConfigTab />}
          {activeTab === 'review' && <NeedsReviewTab />}
        </div>
      </div>
    </Page>
  );
}
