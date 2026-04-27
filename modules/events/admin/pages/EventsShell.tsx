import { lazy, Suspense, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Page } from '@/components/shared/Page';
import { Tabs } from '@/components/ui';
import { useModuleSlots, type ResolvedSlot } from '@/hooks/useModuleSlots';

/**
 * Events dashboard shell. The default tab is the events list. Other modules
 * (e.g. scrapers → Hosts, event-speakers → Speakers) contribute additional
 * tabs via the `events:tab` adminSlot.
 *
 * The shell owns the page title, outer padding, and tab strip so every tab
 * renders with identical chrome. Each tab's component should return inner
 * content only (no <Page>, no outer p-6, no top-level <h1>).
 */

const EventsList = lazy(() => import('./EventsPage'));

interface SlotMeta { tabId?: string; label?: string; icon?: string; }

function tabsFromSlots(slots: ResolvedSlot[]) {
  return slots
    .filter(s => (s.registration.meta as SlotMeta)?.tabId && (s.registration.meta as SlotMeta)?.label)
    .map(s => {
      const meta = s.registration.meta as SlotMeta;
      return {
        id: meta.tabId!,
        label: meta.label!,
        order: s.registration.order ?? 100,
        component: lazy(s.registration.component as () => Promise<{ default: React.ComponentType }>),
      };
    })
    .sort((a, b) => a.order - b.order);
}

export default function EventsShell() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const extraTabs = tabsFromSlots(useModuleSlots('events:tab'));
  const allTabs = useMemo(
    () => [{ id: 'events', label: 'Events' }, ...extraTabs.map(t => ({ id: t.id, label: t.label }))],
    [extraTabs],
  );

  const tabId = useMemo(() => {
    const match = pathname.match(/^\/events\/([^/]+)$/);
    if (!match) return 'events';
    const candidate = match[1];
    return allTabs.some(t => t.id === candidate) ? candidate : 'events';
  }, [pathname, allTabs]);

  const onChange = useCallback((id: string) => {
    if (id === 'events') navigate('/events');
    else navigate(`/events/${id}`);
  }, [navigate]);

  const ActiveExtra = extraTabs.find(t => t.id === tabId)?.component;

  return (
    <Page title="Events">
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Events</h1>
        <Tabs value={tabId} onChange={onChange} tabs={allTabs} />
        <Suspense fallback={<div className="p-8 text-sm text-[var(--gray-11)]">Loading…</div>}>
          {tabId === 'events' ? <EventsList /> : ActiveExtra ? <ActiveExtra /> : null}
        </Suspense>
      </div>
    </Page>
  );
}
