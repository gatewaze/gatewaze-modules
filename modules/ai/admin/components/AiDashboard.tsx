/**
 * Admin: unified AI dashboard.
 *
 * Consolidates Usage, Use-cases, Models, Credentials, and any
 * module-contributed tabs (e.g. editor-ai-copilot's Skill Sources)
 * into a single tabbed surface using the platform's primary tab strip
 * (Radix Tabs via @/components/ui). Pattern mirrors EventsShell.
 *
 * Tabs are encoded in the URL path:
 *   /admin/ai                 → Usage (default)
 *   /admin/ai/usage           → Usage
 *   /admin/ai/use-cases       → Use cases
 *   /admin/ai/models          → Models
 *   /admin/ai/credentials     → Credentials
 *   /admin/ai/skill-sources   → Skill sources (contributed by editor-ai-copilot)
 *
 * Module-contributed tabs register under slotName 'ai-dashboard:tab' with
 * `meta: { tabId, label, order? }`. See editor-ai-copilot/index.ts.
 *
 * The shell owns page chrome (Page title + outer p-6 + the h1 + tab
 * strip). Each tab's component should return inner content only — no
 * outer p-6, no top-level h1.
 */

import { lazy, Suspense, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { Tabs, type Tab } from '@/components/ui';
import { useModuleSlots, type ResolvedSlot } from '@/hooks/useModuleSlots';

import AiAgentSourcesAdmin from './AiAgentSourcesAdmin';
import AiCredentialsAdmin from './AiCredentialsAdmin';
import AiJobsAdmin from './AiJobsAdmin';
import AiMcpServersAdmin from './AiMcpServersAdmin';
import AiMemoryAdmin from './AiMemoryAdmin';
import AiModelsAdmin from './AiModelsAdmin';
import AiRecipesAdmin from './AiRecipesAdmin';
import AiUsageDashboard from './AiUsageDashboard';
import AiUseCasesAdmin from './AiUseCasesAdmin';

interface BuiltinTab extends Tab {
  order: number;
  render: () => JSX.Element;
}

const BUILTIN_TABS: BuiltinTab[] = [
  { id: 'usage', label: 'Usage', order: 10, render: () => <AiUsageDashboard /> },
  { id: 'use-cases', label: 'Use cases', order: 20, render: () => <AiUseCasesAdmin /> },
  { id: 'models', label: 'Models', order: 30, render: () => <AiModelsAdmin /> },
  { id: 'credentials', label: 'Credentials', order: 40, render: () => <AiCredentialsAdmin /> },
  // Agent sources — unified replacement for the previously-separate
  // "Skill sources" and "Recipes (sources)" tabs. One git repo = one
  // row; sync walks both skills/ and recipes/ in one pass.
  { id: 'agent-sources', label: 'Agent sources', order: 50, render: () => <AiAgentSourcesAdmin /> },
  // Recipes — Goose-compatible workflow runner. Sources/recipes/runs
  // surface, mirroring the skill-sources tab.
  { id: 'recipes', label: 'Recipes', order: 60, render: () => <AiRecipesAdmin /> },
  // MCP servers — operator-managed registry of MCP server definitions
  // (stdio / streamable_http / builtin) with per-use-case allowlist.
  // Spec: spec-ai-mcp-extensions.md.
  { id: 'mcp-servers', label: 'MCP servers', order: 65, render: () => <AiMcpServersAdmin /> },
  // Memory — inspector for the gatewaze-memory MCP server's backing
  // store. Shows what models have written via store_memory + scope,
  // TTL, originating message.
  { id: 'memory', label: 'Memory', order: 68, render: () => <AiMemoryAdmin /> },
  // Jobs — live queue inspection (active/waiting/delayed/failed) +
  // per-job stop/retry/promote + live-tail of the SSE stream.
  // Cross-module toggle surfaces the wider BullMQ queue.
  // Spec: spec-ai-job-runner §4.5.
  { id: 'jobs', label: 'Jobs', order: 70, render: () => <AiJobsAdmin /> },
];

interface SlotMeta {
  tabId?: string;
  label?: string;
  order?: number;
}

interface ExtraTab extends Tab {
  order: number;
  component: React.ComponentType;
}

function tabsFromSlots(slots: ResolvedSlot[]): ExtraTab[] {
  return slots
    .filter((s) => {
      const meta = s.registration.meta as SlotMeta | undefined;
      return Boolean(meta?.tabId && meta.label);
    })
    .map((s) => {
      const meta = s.registration.meta as SlotMeta;
      return {
        id: meta.tabId!,
        label: meta.label!,
        order: meta.order ?? s.registration.order ?? 100,
        component: lazy(s.registration.component as () => Promise<{ default: React.ComponentType }>),
      };
    });
}

export default function AiDashboard() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const extraTabs = tabsFromSlots(useModuleSlots('ai-dashboard:tab'));

  const allTabs: Tab[] = useMemo(() => {
    return [
      ...BUILTIN_TABS.map((t) => ({ id: t.id, label: t.label, order: t.order })),
      ...extraTabs.map((t) => ({ id: t.id, label: t.label, order: t.order })),
    ]
      .sort((a, b) => a.order - b.order)
      .map(({ id, label }) => ({ id, label }));
  }, [extraTabs]);

  const tabId = useMemo(() => {
    // Match /admin/ai or /admin/ai/<tab-slug>. The platform mounts our
    // adminRoutes (with `guard: 'admin'`) under /admin/, so the visible
    // URL is /admin/ai/... — but the location pathname reflects that.
    const match = pathname.match(/^\/admin\/ai(?:\/([^/]+))?\/?$/);
    if (!match) return 'usage';
    const candidate = match[1];
    if (!candidate) return 'usage';
    return allTabs.some((t) => t.id === candidate) ? candidate : 'usage';
  }, [pathname, allTabs]);

  const onChange = useCallback(
    (id: string) => {
      if (id === 'usage') navigate('/admin/ai');
      else navigate(`/admin/ai/${id}`);
    },
    [navigate],
  );

  const ActiveBuiltin = BUILTIN_TABS.find((t) => t.id === tabId);
  const ActiveExtra = extraTabs.find((t) => t.id === tabId)?.component;

  return (
    <Page title="AI">
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold text-[var(--gray-12)]">AI</h1>
        <Tabs value={tabId} onChange={onChange} tabs={allTabs} />
        <Suspense
          fallback={
            <div className="p-8 flex justify-center">
              <LoadingSpinner />
            </div>
          }
        >
          {ActiveBuiltin ? ActiveBuiltin.render() : ActiveExtra ? <ActiveExtra /> : null}
        </Suspense>
      </div>
    </Page>
  );
}
