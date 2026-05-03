/**
 * Site detail page — /sites/:siteSlug/[:tab]
 *
 * Hero header + tabbed dashboard (Pages, Source, Media, Menus, Publishing, Settings),
 * mirroring the newsletters detail layout for visual consistency.
 *
 * Per spec-content-modules-git-architecture §7.1.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  ArrowLeftIcon,
  CodeBracketIcon,
  DocumentTextIcon,
  PhotoIcon,
  Bars3Icon,
  RocketLaunchIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Badge, Tabs } from '@/components/ui';
import type { Tab } from '@/components/ui/Tabs';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { SitesService } from '../services/sitesService';
import type { SiteRow } from '../../types';
import { SiteSourceTab } from '../components/SiteSourceTab';
import { SitePagesTab } from '../components/SitePagesTab';
import { SiteMediaTab } from '../components/SiteMediaTab';
import { SiteMenusTab } from '../components/SiteMenusTab';
import { SitePublishingTab } from '../components/SitePublishingTab';
import { SiteSettingsTab } from '../components/SiteSettingsTab';

const VALID_TABS = ['pages', 'source', 'media', 'menus', 'publishing', 'settings'] as const;
type TabKey = (typeof VALID_TABS)[number];

export default function SiteDetailPage() {
  const { siteSlug, tab } = useParams<{ siteSlug: string; tab?: string }>();
  const navigate = useNavigate();

  const [site, setSite] = useState<SiteRow | null>(null);
  const [loading, setLoading] = useState(true);

  const activeTab: TabKey =
    tab && VALID_TABS.includes(tab as TabKey) ? (tab as TabKey) : 'pages';

  const navigateToTab = (newTab: TabKey) => {
    navigate(`/sites/${siteSlug}/${newTab}`);
  };

  const loadSite = async () => {
    if (!siteSlug) return;
    setLoading(true);
    const { site, error } = await SitesService.getSite(siteSlug);
    if (error) {
      toast.error(`Failed to load site: ${error}`);
      navigate('/sites');
      return;
    }
    if (!site) {
      toast.error(`Site not found: ${siteSlug}`);
      navigate('/sites');
      return;
    }
    setSite(site);
    setLoading(false);
  };

  useEffect(() => {
    loadSite();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteSlug]);

  if (loading || !site) {
    return (
      <Page title="Loading site...">
        <LoadingSpinner />
      </Page>
    );
  }

  const isPortalSite = site.publishing_target.kind === 'portal' && site.slug === 'portal';
  const accentColor = '#00a2c7';
  const ic = 'size-4';

  const targetLabel =
    site.publishing_target.kind === 'external' && site.publishing_target.publisherId
      ? site.publishing_target.publisherId.replace(/^sites-publisher-/, '')
      : site.publishing_target.kind;

  // Portal site (option B from spec §16) hides Media + Menus tabs since portal
  // serves its own assets and uses hardcoded nav.
  const tabs: Tab[] = [
    { id: 'pages', label: 'Pages', icon: <DocumentTextIcon className={ic} /> },
    { id: 'source', label: 'Source', icon: <CodeBracketIcon className={ic} /> },
    ...(isPortalSite
      ? []
      : [
          { id: 'media', label: 'Media', icon: <PhotoIcon className={ic} /> },
          { id: 'menus', label: 'Menus', icon: <Bars3Icon className={ic} /> },
        ]),
    { id: 'publishing', label: 'Publishing', icon: <RocketLaunchIcon className={ic} /> },
    { id: 'settings', label: 'Settings', icon: <Cog6ToothIcon className={ic} /> },
  ];

  return (
    <Page title={site.name}>
      {/* Hero header */}
      <div
        className="relative -mx-(--margin-x) -mt-(--margin-x) overflow-hidden"
        style={{
          background: `linear-gradient(135deg, #1a1a2e 0%, ${accentColor}30 50%, #1a1a2e 100%)`,
        }}
      >
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 to-black/60 pointer-events-none" />
        <div className="relative" style={{ padding: '1.5rem calc(var(--margin-x) + 1.5rem) 1.75rem' }}>
          <button
            onClick={() => navigate('/sites')}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-white/90 backdrop-blur-md border border-white/40 text-gray-900 shadow-sm hover:bg-white transition-colors mb-3"
          >
            <ArrowLeftIcon className="w-4 h-4" /> Back
          </button>
          <h1 className="text-2xl md:text-3xl lg:text-4xl font-bold text-white mb-2">{site.name}</h1>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="px-3 py-1.5 bg-white/10 backdrop-blur-sm rounded-lg text-sm text-white/90 font-mono">
              {site.slug}
            </span>
            <span className="px-3 py-1.5 bg-white/10 backdrop-blur-sm rounded-lg text-sm text-white/90">
              publishes via {targetLabel}
            </span>
            {site.status !== 'active' && (
              <Badge variant="soft" color="orange" size="1">{site.status}</Badge>
            )}
            {isPortalSite && (
              <Badge variant="soft" color="blue" size="1">platform</Badge>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="-mx-(--margin-x)">
        <Tabs fullWidth value={activeTab} onChange={(t: string) => navigateToTab(t as TabKey)} tabs={tabs} />
      </div>

      {/* Tab content */}
      <div className="-mx-(--margin-x) py-6" style={{ padding: '1.5rem calc(var(--margin-x) + 1.5rem)' }}>
        {activeTab === 'pages' && <SitePagesTab site={site} />}
        {activeTab === 'source' && <SiteSourceTab site={site} onSiteUpdated={(s) => setSite(s)} />}
        {activeTab === 'media' && !isPortalSite && <SiteMediaTab site={site} />}
        {activeTab === 'menus' && !isPortalSite && <SiteMenusTab site={site} />}
        {activeTab === 'publishing' && <SitePublishingTab site={site} onSiteUpdated={(s) => setSite(s)} />}
        {activeTab === 'settings' && <SiteSettingsTab site={site} onSiteUpdated={(s) => setSite(s)} />}
      </div>
    </Page>
  );
}
