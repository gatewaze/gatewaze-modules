/**
 * Pure tab logic for the Events dashboard shell.
 *
 * Extracted from EventsShell.tsx so the slot-filtering, tab-assembly, and
 * URL <-> tab-id mapping can be unit-tested in the module's node vitest
 * without rendering React or resolving the admin package's `@/` aliases.
 * The shell stays a thin presentational shim over these helpers (it only
 * adds `lazy()` wrapping + <WorkspaceLayout> chrome).
 */

/** Shape of the `meta` bag a module attaches to an `events:tab` slot. */
export interface SlotMeta {
  tabId?: string;
  label?: string;
  icon?: string;
}

/**
 * Minimal structural view of a resolved `events:tab` slot — matches
 * `ResolvedSlot` from `@/hooks/useModuleSlots` without importing it, so this
 * module stays free of `@/` aliases and React at runtime.
 */
export interface RawTabSlot {
  registration: {
    meta?: unknown;
    order?: number;
    component: unknown;
  };
}

/** A contributed tab after filtering/sorting: id + label + its lazy import. */
export interface EventsTabDescriptor {
  id: string;
  label: string;
  order: number;
  component: unknown;
}

/** The always-present first tab (the events list). */
export const EVENTS_BASE_TAB = { id: 'events', label: 'Events' } as const;

/**
 * Filter `events:tab` slots down to those carrying a usable `tabId` + `label`,
 * then sort by declared order (default 100). Pure — no React, no side effects.
 */
export function extractTabDescriptors(slots: RawTabSlot[]): EventsTabDescriptor[] {
  return slots
    .filter((s) => {
      const meta = s.registration.meta as SlotMeta | undefined;
      return Boolean(meta?.tabId && meta?.label);
    })
    .map((s) => {
      const meta = s.registration.meta as SlotMeta;
      return {
        id: meta.tabId!,
        label: meta.label!,
        order: s.registration.order ?? 100,
        component: s.registration.component,
      };
    })
    .sort((a, b) => a.order - b.order);
}

/**
 * Full tab strip for the shell: the base "Events" tab first, then every
 * contributed tab. Returns the minimal `{ id, label }` shape the shared
 * <WorkspaceLayout>/<Tabs> accept.
 */
export function buildEventsTabs(
  descriptors: EventsTabDescriptor[],
): Array<{ id: string; label: string }> {
  return [
    { id: EVENTS_BASE_TAB.id, label: EVENTS_BASE_TAB.label },
    ...descriptors.map((t) => ({ id: t.id, label: t.label })),
  ];
}

/**
 * Derive the active tab id from the current pathname. Only a single
 * `/events/<tabId>` segment counts; anything deeper (e.g. an event detail
 * route `/events/:eventId/...`) or an unknown tab falls back to `events`.
 */
export function resolveActiveTabId(pathname: string, tabIds: readonly string[]): string {
  const match = pathname.match(/^\/events\/([^/]+)$/);
  if (!match) return EVENTS_BASE_TAB.id;
  const candidate = match[1];
  return tabIds.includes(candidate) ? candidate : EVENTS_BASE_TAB.id;
}

/** Navigation target for a tab id (base tab maps to `/events`). */
export function eventsTabPath(id: string): string {
  return id === EVENTS_BASE_TAB.id ? '/events' : `/events/${id}`;
}
