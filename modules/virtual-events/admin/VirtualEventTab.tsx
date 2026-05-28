import { useState, lazy, Suspense } from 'react';
import {
  Cog6ToothIcon,
  ChatBubbleLeftRightIcon,
  ShieldCheckIcon,
  PresentationChartBarIcon,
} from '@heroicons/react/24/outline';

const VirtualEventConfigTab = lazy(() => import('./VirtualEventConfigTab'));
const ModeratorView = lazy(() => import('./ModeratorView'));
const PresenterView = lazy(() => import('./PresenterView'));

interface VirtualEventTabProps {
  eventUuid: string;
}

const SUB_TABS = [
  { id: 'settings', label: 'Settings', icon: Cog6ToothIcon },
  { id: 'moderate', label: 'Moderate', icon: ShieldCheckIcon },
  { id: 'present', label: 'Present', icon: PresentationChartBarIcon },
] as const;

type SubTabId = typeof SUB_TABS[number]['id'];

export default function VirtualEventTab({ eventUuid }: VirtualEventTabProps) {
  const [activeSubTab, setActiveSubTab] = useState<SubTabId>('settings');

  return (
    <div className="space-y-4">
      {/* Sub-tab navigation */}
      <div className="flex gap-1 p-1 bg-[var(--gray-3)] rounded-lg w-fit">
        {SUB_TABS.map(tab => {
          const Icon = tab.icon;
          const isActive = activeSubTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveSubTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors cursor-pointer ${
                isActive
                  ? 'bg-[var(--color-background)] text-[var(--gray-12)] shadow-sm'
                  : 'text-[var(--gray-9)] hover:text-[var(--gray-12)]'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Sub-tab content */}
      <Suspense fallback={<div className="py-8 text-center text-[var(--gray-9)]">Loading...</div>}>
        {activeSubTab === 'settings' && <VirtualEventConfigTab eventUuid={eventUuid} />}
        {activeSubTab === 'moderate' && <ModeratorView eventUuid={eventUuid} />}
        {activeSubTab === 'present' && <PresenterView eventUuid={eventUuid} />}
      </Suspense>
    </div>
  );
}
