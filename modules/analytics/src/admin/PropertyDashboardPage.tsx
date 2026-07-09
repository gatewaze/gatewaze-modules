/**
 * Property workspace — the per-property analytics surface, per spec §12.2.
 *
 * WorkspaceLayout hero + combined breadcrumb/sub-tab row (breadcrumb
 * flag on the left, Overview | Sessions | Retention | Settings tabs to
 * its right — same pattern as newsletter editions, since the tabs apply
 * to the breadcrumb's entity). Range picker in the hero actions. Tab
 * state is
 * URL-synced: /analytics/properties/:id renders Overview and
 * /analytics/properties/:id/settings deep-links the Settings tab (the
 * standalone settings route renders this same shell).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { WorkspaceLayout } from '@/components/ui';
import { getJson, RANGES, type RangeKey } from './tabs/shared';
import OverviewTab from './tabs/OverviewTab';
import RealtimeTab from './tabs/RealtimeTab';
import SessionsTab from './tabs/SessionsTab';
import JourneysTab from './tabs/JourneysTab';
import FunnelsTab from './tabs/FunnelsTab';
import UtmTab from './tabs/UtmTab';
import LinksTab from './tabs/LinksTab';
import RetentionTab from './tabs/RetentionTab';
import SettingsTab from './tabs/SettingsTab';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'realtime', label: 'Realtime' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'journeys', label: 'Journeys' },
  { id: 'funnels', label: 'Funnels' },
  { id: 'utm', label: 'UTM' },
  { id: 'links', label: 'Links' },
  { id: 'retention', label: 'Retention' },
  { id: 'settings', label: 'Settings' },
];

export default function PropertyDashboardPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [rangeKey, setRangeKey] = useState<RangeKey>('7d');
  const [propertyName, setPropertyName] = useState<string>('');

  const activeTab = location.pathname.endsWith('/settings') ? 'settings' : (location.hash.replace('#', '') || 'overview');

  const onTabChange = useCallback((tabId: string) => {
    if (!id) return;
    if (tabId === 'settings') {
      navigate(`/analytics/properties/${id}/settings`);
    } else {
      navigate(`/analytics/properties/${id}${tabId === 'overview' ? '' : `#${tabId}`}`);
    }
  }, [id, navigate]);

  useEffect(() => {
    if (!id) return;
    getJson<{ property: { name: string } }>(`/api/modules/analytics/properties/${id}`)
      .then((b) => setPropertyName(b.property?.name ?? ''))
      .catch(() => undefined);
  }, [id]);

  const rangePicker = useMemo(() => (
    <div className="flex rounded-lg overflow-hidden border border-white/25">
      {(Object.keys(RANGES) as RangeKey[]).map((k) => (
        <button
          key={k}
          onClick={() => setRangeKey(k)}
          className={`px-3 py-1.5 text-sm transition-colors ${
            rangeKey === k ? 'bg-white/25 font-semibold' : 'hover:bg-white/10'
          }`}
        >
          {RANGES[k].label}
        </button>
      ))}
    </div>
  ), [rangeKey]);

  if (!id) return <div className="p-8">Missing property id</div>;

  return (
    <WorkspaceLayout
      title="Analytics"
      breadcrumbs={[{ label: 'Analytics', to: '/analytics' }, { label: propertyName || 'Property' }]}
      onBreadcrumbNavigate={(to: string) => navigate(to)}
      subTabs={TABS}
      activeSubTabId={activeTab}
      onSubTabChange={onTabChange}
      actions={['settings', 'realtime', 'links'].includes(activeTab) ? undefined : rangePicker}
    >
      <div className="px-6 py-6 max-w-7xl mx-auto">
        {activeTab === 'overview' && <OverviewTab propertyId={id} rangeKey={rangeKey} />}
        {activeTab === 'realtime' && <RealtimeTab propertyId={id} />}
        {activeTab === 'sessions' && <SessionsTab propertyId={id} rangeKey={rangeKey} />}
        {activeTab === 'journeys' && <JourneysTab propertyId={id} rangeKey={rangeKey} />}
        {activeTab === 'funnels' && <FunnelsTab propertyId={id} rangeKey={rangeKey} />}
        {activeTab === 'utm' && <UtmTab propertyId={id} rangeKey={rangeKey} />}
        {activeTab === 'links' && <LinksTab propertyId={id} />}
        {activeTab === 'retention' && <RetentionTab propertyId={id} rangeKey={rangeKey} />}
        {activeTab === 'settings' && <SettingsTab propertyId={id} />}
      </div>
    </WorkspaceLayout>
  );
}
