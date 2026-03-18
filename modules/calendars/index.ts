import type { GatewazeModule } from '@gatewaze/shared';

const calendarsModule: GatewazeModule = {
  id: 'calendars',
  type: 'feature',
  visibility: 'public',
  name: 'Calendars',
  description: 'Manage event calendars with discovery, CSV import, and scheduling APIs',
  version: '1.0.0',
  features: [
    'calendars',
    'calendars.discover',
    'calendars.import',
  ],

  edgeFunctions: [
    'calendars-api',
    'calendars-discover',
    'calendars-process-csv',
  ],

  migrations: [
    'migrations/001_calendars_tables.sql',
  ],

  adminRoutes: [
    { path: 'calendars', component: () => import('./admin/pages/index'), requiredFeature: 'calendars', guard: 'none' },
    { path: 'calendars/:calendarId', component: () => import('./admin/pages/detail'), requiredFeature: 'calendars', guard: 'none' },
    { path: 'calendars/:calendarId/:tab', component: () => import('./admin/pages/detail'), requiredFeature: 'calendars', guard: 'none' },
  ],

  adminNavItems: [
    { path: '/calendars', label: 'Calendars', icon: 'Calendar', requiredFeature: 'calendars', order: 13 },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[calendars] Module installed');
  },

  onEnable: async () => {
    console.log('[calendars] Module enabled');
  },

  onDisable: async () => {
    console.log('[calendars] Module disabled');
  },
};

export default calendarsModule;
