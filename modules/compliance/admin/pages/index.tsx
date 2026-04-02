import { useState } from 'react';
import {
  ShieldCheckIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
  ClipboardDocumentListIcon,
  GlobeAltIcon,
  NoSymbolIcon,
} from '@heroicons/react/24/outline';
import { Tabs } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { PrivacyRequestsTab } from './PrivacyRequestsTab';
import { DataBreachesTab } from './DataBreachesTab';
import { ConsentRecordsTab } from './ConsentRecordsTab';
import { ProcessingActivitiesTab } from './ProcessingActivitiesTab';
import { CrossBorderTransfersTab } from './CrossBorderTransfersTab';
import { CCPAPreferencesTab } from './CCPAPreferencesTab';

type TabType = 'privacy-requests' | 'data-breaches' | 'consent-records' | 'ccpa-preferences' | 'processing-activities' | 'cross-border';

export default function CompliancePage() {
  const [activeTab, setActiveTab] = useState<TabType>('privacy-requests');

  const tabs = [
    { id: 'privacy-requests' as TabType, label: 'Privacy Requests', icon: <ShieldCheckIcon className="size-4" /> },
    { id: 'data-breaches' as TabType, label: 'Data Breaches', icon: <ExclamationTriangleIcon className="size-4" /> },
    { id: 'consent-records' as TabType, label: 'Consent Records', icon: <DocumentTextIcon className="size-4" /> },
    { id: 'ccpa-preferences' as TabType, label: 'CCPA Preferences', icon: <NoSymbolIcon className="size-4" /> },
    { id: 'processing-activities' as TabType, label: 'Processing Activities', icon: <ClipboardDocumentListIcon className="size-4" /> },
    { id: 'cross-border' as TabType, label: 'Cross-Border Transfers', icon: <GlobeAltIcon className="size-4" /> },
  ];

  return (
    <Page title="Compliance">
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
            Privacy Compliance
          </h1>
          <p className="text-[var(--gray-11)] mt-1">
            Manage privacy requests, data breaches, consent records, and compliance documentation
          </p>
        </div>

        {/* Tab Navigation */}
        <Tabs
          value={activeTab}
          onChange={(tab) => setActiveTab(tab as TabType)}
          tabs={tabs}
          className="mb-6"
        />

        {/* Tab Content */}
        {activeTab === 'privacy-requests' && <PrivacyRequestsTab />}
        {activeTab === 'data-breaches' && <DataBreachesTab />}
        {activeTab === 'consent-records' && <ConsentRecordsTab />}
        {activeTab === 'ccpa-preferences' && <CCPAPreferencesTab />}
        {activeTab === 'processing-activities' && <ProcessingActivitiesTab />}
        {activeTab === 'cross-border' && <CrossBorderTransfersTab />}
      </div>
    </Page>
  );
}
