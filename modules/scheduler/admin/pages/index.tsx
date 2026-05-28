import { useState } from 'react';
import { Page } from '@/components/shared/Page';
import { Tab, TabGroup, TabList, TabPanel, TabPanels } from '@headlessui/react';
import { JobsOverviewTab } from './JobsOverviewTab';
import { JobsHistoryTab } from './JobsHistoryTab';
import { ScheduledJobsTab } from './ScheduledJobsTab';
import { ScraperSchedulesTab } from './ScraperSchedulesTab';

const tabs = [
  { name: 'Overview', component: JobsOverviewTab },
  { name: 'History', component: JobsHistoryTab },
  { name: 'Scraper Schedules', component: ScraperSchedulesTab },
  { name: 'BullMQ Repeatable', component: ScheduledJobsTab },
];

export default function JobsPage() {
  const [selectedIndex, setSelectedIndex] = useState(0);

  return (
    <Page title="Background Jobs">
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
            Background Jobs
          </h1>
          <p className="text-[var(--gray-11)] mt-1">
            Monitor and manage background job processing
          </p>
        </div>

        <TabGroup selectedIndex={selectedIndex} onChange={setSelectedIndex}>
          <TabList className="flex space-x-1 rounded-xl bg-[var(--gray-a3)] p-1">
            {tabs.map((tab) => (
              <Tab
                key={tab.name}
                className={({ selected }) =>
                  `w-full rounded-lg py-2.5 text-sm font-medium leading-5 transition-colors
                  ${
                    selected
                      ? 'bg-[var(--color-background)] text-primary-600 dark:text-primary-400 shadow'
                      : 'text-[var(--gray-11)] hover:bg-[var(--gray-a3)] hover:text-gray-900 dark:hover:text-white'
                  }`
                }
              >
                {tab.name}
              </Tab>
            ))}
          </TabList>

          <TabPanels className="mt-4">
            {tabs.map((tab, idx) => (
              <TabPanel key={idx}>
                <tab.component />
              </TabPanel>
            ))}
          </TabPanels>
        </TabGroup>
      </div>
    </Page>
  );
}
