/**
 * tasks module — Asana-style task management.
 *
 * Spec: gatewaze-environments/specs/spec-tasks-module.md
 */

import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const tasksModule: GatewazeModule = {
  id: 'tasks',
  type: 'feature',
  visibility: 'public',
  group: 'productivity',
  name: 'Tasks',
  description:
    'Asana-style task management with tree/kanban/calendar views and cross-module linking',
  version: '1.0.0',
  features: [
    'tasks',
    'tasks.boards.manage',
    'tasks.boards.create',
    'tasks.webhooks',
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRoutes(app as any, context);
  },

  migrations: [
    'migrations/001_task_boards.sql',
    'migrations/002_board_members.sql',
    'migrations/003_board_statuses.sql',
    'migrations/004_board_custom_fields.sql',
    'migrations/005_tasks.sql',
    'migrations/006_task_field_values.sql',
    'migrations/007_task_dependencies.sql',
    'migrations/008_task_links.sql',
    'migrations/009_task_comments.sql',
    'migrations/010_task_activity.sql',
    'migrations/011_task_notifications.sql',
    'migrations/012_board_webhooks.sql',
    'migrations/013_task_user_prefs.sql',
    'migrations/014_realtime_publications.sql',
    'migrations/015_triggers.sql',
    'migrations/016_recurrence_state.sql',
    'migrations/017_webhook_outbox.sql',
  ],

  adminRoutes: [
    {
      path: 'tasks',
      component: () => import('./admin/pages/BoardsListPage'),
      requiredFeature: 'tasks',
      guard: 'admin',
    },
    {
      path: 'tasks/inbox',
      component: () => import('./admin/pages/TaskInboxPage'),
      requiredFeature: 'tasks',
      guard: 'admin',
    },
    {
      path: 'tasks/boards/:id',
      component: () => import('./admin/pages/BoardDetailPage'),
      requiredFeature: 'tasks',
      guard: 'admin',
    },
    // No /settings route: board settings render as a SideDrawer overlay
    // inside BoardDetailPage (opened by the "Settings" button).
  ],

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/slots/EntityTasksTab'),
      requiredFeature: 'tasks',
      meta: { tabId: 'tasks', label: 'Tasks', icon: 'ClipboardDocumentCheck', entityType: 'events' },
    },
    {
      slotName: 'speaker-detail:tab',
      component: () => import('./admin/slots/EntityTasksTab'),
      requiredFeature: 'tasks',
      meta: { tabId: 'tasks', label: 'Tasks', icon: 'ClipboardDocumentCheck', entityType: 'speakers' },
    },
    {
      slotName: 'content-detail:tab',
      component: () => import('./admin/slots/EntityTasksTab'),
      requiredFeature: 'tasks',
      meta: { tabId: 'tasks', label: 'Tasks', icon: 'ClipboardDocumentCheck', entityType: 'content_items' },
    },
    {
      slotName: 'list-detail:tab',
      component: () => import('./admin/slots/EntityTasksTab'),
      requiredFeature: 'tasks',
      meta: { tabId: 'tasks', label: 'Tasks', icon: 'ClipboardDocumentCheck', entityType: 'lists' },
    },
  ],

  adminNavItems: [
    {
      path: '/admin/tasks',
      label: 'Tasks',
      // ClipboardDocumentCheck resolves to HeroOutline.ClipboardDocumentCheckIcon
      // via packages/admin/src/app/navigation/icons.ts auto-derived map.
      icon: 'ClipboardDocumentCheck',
      requiredFeature: 'tasks',
      parentGroup: 'admin',
      order: 12,
    },
    {
      path: '/admin/tasks/inbox',
      label: 'Inbox',
      icon: 'Inbox',
      requiredFeature: 'tasks',
      parentGroup: 'admin',
      order: 13,
    },
  ],

  workers: [
    {
      name: 'tasks:recurrence-spawner',
      handler: './scripts/workers/recurrence-spawner.js',
      concurrency: 1,
    },
    {
      name: 'tasks:email-digest-sender',
      handler: './scripts/workers/email-digest-sender.js',
      concurrency: 1,
    },
    {
      name: 'tasks:webhook-dispatcher',
      handler: './scripts/workers/webhook-dispatcher.js',
      concurrency: 4,
    },
    {
      name: 'tasks:due-soon-notifier',
      handler: './scripts/workers/due-soon-notifier.js',
      concurrency: 1,
    },
  ],

  configSchema: {
    TASKS_WEBHOOK_ENCRYPTION_KEY: {
      key: 'TASKS_WEBHOOK_ENCRYPTION_KEY',
      type: 'secret',
      required: false,
      description:
        'Application-layer AES key for board_webhooks.url and secret encryption (§10.5). When unset, the module logs a degraded-mode warning and stores plaintext.',
    },
  },
};

export default tasksModule;
