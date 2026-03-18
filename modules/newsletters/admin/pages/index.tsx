import { useParams, useNavigate } from 'react-router';
import { Tabs } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { EditionsTab } from './EditionsTab';
import { EditorTab } from './EditorTab';
import { NewsletterLeaderboardTab } from '../admin/redirects/newsletter/NewsletterLeaderboardTab';
import { NewsletterTrendsTab } from '../admin/redirects/newsletter/NewsletterTrendsTab';

type TabType = 'editions' | 'editor' | 'leaderboard' | 'trends';

const validTabs: TabType[] = ['editions', 'editor', 'leaderboard', 'trends'];

export default function NewslettersPage() {
  const { tab } = useParams<{ tab: string }>();
  const navigate = useNavigate();

  // Default to 'editions' if tab is invalid or missing
  const activeTab: TabType = validTabs.includes(tab as TabType) ? (tab as TabType) : 'editions';

  const handleTabChange = (newTab: TabType) => {
    navigate(`/newsletters/${newTab}`);
  };

  const tabs = [
    { id: 'editions' as TabType, label: 'Editions' },
    { id: 'editor' as TabType, label: 'Editor' },
    { id: 'leaderboard' as TabType, label: 'Leaderboard' },
    { id: 'trends' as TabType, label: 'Trends' },
  ];

  return (
    <Page title="Newsletters">
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
            Newsletters
          </h1>
          <p className="text-[var(--gray-11)] mt-1">
            Manage newsletter editions and track link performance
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
          {activeTab === 'editions' && <EditionsTab />}
          {activeTab === 'editor' && <EditorTab />}
          {activeTab === 'leaderboard' && <NewsletterLeaderboardTab />}
          {activeTab === 'trends' && <NewsletterTrendsTab />}
        </div>
      </div>
    </Page>
  );
}
