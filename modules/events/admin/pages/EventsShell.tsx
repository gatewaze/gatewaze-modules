import { lazy, Suspense, useCallback, useMemo, type ComponentType } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Page } from '@/components/shared/Page';
import { WorkspaceLayout } from '@/components/ui';
import { useModuleSlots } from '@/hooks/useModuleSlots';
import {
  buildEventsTabs,
  eventsTabPath,
  extractTabDescriptors,
  resolveActiveTabId,
} from './eventsTabs';

/**
 * Events dashboard shell. The default tab is the events list. Other modules
 * (e.g. scrapers → Hosts, event-speakers → Speakers) contribute additional
 * tabs via the `events:tab` adminSlot.
 *
 * The shell wraps every tab in the shared <WorkspaceLayout> hero + tab strip
 * so the Events dashboard matches the house style used by Podcasts, Blog,
 * Newsletters, etc. Each tab's component should return inner content only
 * (no <Page>, no outer p-6, no top-level <h1> — the hero owns the title).
 *
 * The slot-filtering, tab-assembly, and URL <-> tab-id mapping live in the
 * pure `./eventsTabs` helper so they can be unit-tested without React.
 */

const EventsList = lazy(() => import('./EventsPage'));

type ComponentImport = () => Promise<{ default: ComponentType }>;

export default function EventsShell() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const slots = useModuleSlots('events:tab');
  const extraTabs = useMemo(() => extractTabDescriptors(slots), [slots]);
  const allTabs = useMemo(() => buildEventsTabs(extraTabs), [extraTabs]);

  const tabId = useMemo(
    () => resolveActiveTabId(pathname, allTabs.map((t) => t.id)),
    [pathname, allTabs],
  );

  const onChange = useCallback((id: string) => {
    navigate(eventsTabPath(id));
  }, [navigate]);

  // Wrap only the active contributed tab in lazy(), memoised on its id so the
  // component isn't re-created (and thus remounted) on every render.
  const ActiveExtra = useMemo(() => {
    const found = extraTabs.find((t) => t.id === tabId);
    return found ? lazy(found.component as ComponentImport) : null;
  }, [extraTabs, tabId]);

  return (
    <Page title="Events">
      <WorkspaceLayout
        title="Events"
        tabs={allTabs}
        activeTabId={tabId}
        onTabChange={onChange}
      >
        <Suspense fallback={<div className="py-8 text-sm text-[var(--gray-11)]">Loading…</div>}>
          {tabId === 'events' ? <EventsList /> : ActiveExtra ? <ActiveExtra /> : null}
        </Suspense>
      </WorkspaceLayout>
    </Page>
  );
}
