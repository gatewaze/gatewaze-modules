import { Suspense, lazy, useCallback, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Page } from '@/components/shared/Page';
import { Tabs } from '@/components/ui';
import { useModuleSlots, type ResolvedSlot } from '@/hooks/useModuleSlots';

/**
 * Top-level sections of the Content hub. Each section is a slot name
 * (`content-hub:<section>`) that other modules contribute sub-tabs to.
 *
 * Sections are fixed in this shell because they represent stable IA
 * concepts (Inbox = work to do, Library = what we have, Rules = how we
 * govern it, Sources = where it comes from). Sub-tabs within each
 * section are dynamic.
 */
// 'Inbox' section removed — superseded by the unified /admin/inbox page in
// the content-platform module.
const SECTIONS = [
  { id: 'library', label: 'Library', slot: 'content-hub:library', order: 20 },
  { id: 'rules',   label: 'Rules',   slot: 'content-hub:rules',   order: 30 },
  { id: 'sources', label: 'Sources', slot: 'content-hub:sources', order: 40 },
] as const;

type SectionId = typeof SECTIONS[number]['id'];

interface SubTabSlotMeta {
  tabId?: string;
  label?: string;
  description?: string;
  icon?: string;
}

function subTabsFromSlots(slots: ResolvedSlot[]) {
  return slots
    .filter(s => (s.registration.meta as SubTabSlotMeta)?.tabId && (s.registration.meta as SubTabSlotMeta)?.label)
    .map(s => {
      const meta = s.registration.meta as SubTabSlotMeta;
      return {
        id: meta.tabId!,
        label: meta.label!,
        order: s.registration.order ?? 100,
        component: s.registration.component,
      };
    })
    .sort((a, b) => a.order - b.order);
}

export default function ContentShell() {
  const navigate = useNavigate();
  const params = useParams<{ section?: string; tab?: string }>();

  // Resolve section + tab with fallbacks.
  const sectionId: SectionId =
    (SECTIONS.find(s => s.id === params.section)?.id) ?? 'library';

  const slots = useModuleSlots(`content-hub:${sectionId}`);
  const subTabs = useMemo(() => subTabsFromSlots(slots), [slots]);

  const tabId = params.tab && subTabs.some(t => t.id === params.tab)
    ? params.tab
    : subTabs[0]?.id;

  // Admin routes mount under /admin, so absolute navigations must use
  // /admin/content/... — using bare /content/... would leave the admin shell.
  useEffect(() => {
    if (!params.section) {
      navigate(`/admin/content/${sectionId}`, { replace: true });
    } else if (!params.tab && tabId) {
      navigate(`/admin/content/${sectionId}/${tabId}`, { replace: true });
    }
  }, [params.section, params.tab, sectionId, tabId, navigate]);

  const navigateToSection = useCallback((newSection: string) => {
    navigate(`/admin/content/${newSection}`);
  }, [navigate]);

  const navigateToSubTab = useCallback((newTab: string) => {
    navigate(`/admin/content/${sectionId}/${newTab}`);
  }, [navigate, sectionId]);

  // Pre-create one lazy wrapper per sub-tab and reuse them across renders.
  // Creating a fresh lazy() wrapper inline whenever tabId changes makes
  // React treat each switch as a brand-new component type and the swap
  // doesn't reliably commit (manifests as the URL changing but the
  // rendered tab content staying on the previous tab).
  const lazyTabs = useMemo(
    () => subTabs.map(t => ({
      id: t.id,
      label: t.label,
      Component: lazy(t.component as () => Promise<{ default: React.ComponentType<any> }>),
    })),
    [subTabs],
  );

  const activeTab = lazyTabs.find(t => t.id === tabId) ?? null;
  const ActiveComponent = activeTab?.Component ?? null;

  return (
    <Page title="Content">
      <div className="border-b border-[var(--gray-a4)]">
        <Tabs
          value={sectionId}
          onChange={(id) => navigateToSection(id)}
          tabs={SECTIONS.map(s => ({ id: s.id, label: s.label }))}
        />
      </div>

      {subTabs.length === 0 ? (
        <div className="p-8 text-sm text-[var(--gray-11)]">
          No content modules contribute to <code>{sectionId}</code> yet.
          Install or enable a module that registers a
          <code> content-hub:{sectionId} </code> slot.
        </div>
      ) : (
        <>
          <div className="px-4 pt-2 border-b border-[var(--gray-a3)]">
            <Tabs
              value={tabId ?? subTabs[0].id}
              onChange={navigateToSubTab}
              tabs={subTabs.map(t => ({ id: t.id, label: t.label }))}
            />
          </div>

          <div className="content-hub-tab-content">
            {ActiveComponent ? (
              <Suspense
                key={tabId}
                fallback={<div className="p-8 text-sm text-[var(--gray-11)]">Loading…</div>}
              >
                <ActiveComponent />
              </Suspense>
            ) : (
              <div className="p-8 text-sm text-[var(--gray-11)]">No tab selected.</div>
            )}
          </div>
        </>
      )}
    </Page>
  );
}
