import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const eventsModule: GatewazeModule = {
  id: 'events',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Events',
  description: 'Core events management - create, manage, and run events with registrations, attendance tracking, and check-in',
  version: '1.0.0',
  features: [
    'events',
    'events.registrations',
    'events.attendance',
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api');
    registerRoutes(app as any, context);
  },

  migrations: [
    'migrations/001_create_events_tables.sql',
    'migrations/002_events_rls_functions.sql',
    'migrations/003_content_category.sql',
  ],

  edgeFunctions: [
    'events',
    'events-registration',
    'events-search',
    'events-generate-matches',
    'events-send-match-emails',
  ],

  adminRoutes: [
    {
      path: 'events',
      component: () => import('./admin/pages/EventsPage'),
      requiredFeature: 'events',
    },
    {
      path: 'events/:eventId',
      component: () => import('./admin/pages/EventDetailPage'),
      requiredFeature: 'events',
    },
    {
      path: 'events/:eventId/:tab',
      component: () => import('./admin/pages/EventDetailPage'),
      requiredFeature: 'events',
    },
  ],

  adminNavItems: [
    {
      path: '/events',
      label: 'Events',
      icon: 'admin.events',
      requiredFeature: 'events',
      parentGroup: 'dashboards',
      order: 15,
    },
  ],

  adminSlots: [
    {
      slotName: 'person-detail:events',
      component: () => import('./admin/components/PersonEventsTab'),
      order: 10,
      requiredFeature: 'events',
    },
  ],

  portalNav: {
    label: 'Events',
    path: '/events/upcoming',
    icon: 'calendar',
    order: 10,
  },

  dependencies: [],

  configSchema: {},

  onInstall: async () => {
    console.log('[events] Module installed');
  },

  onEnable: async () => {
    console.log('[events] Module enabled');
  },

  onDisable: async () => {
    console.log('[events] Module disabled');
  },
};

export default eventsModule;
