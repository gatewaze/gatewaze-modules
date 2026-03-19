import type { GatewazeModule } from '@gatewaze/shared';

const eventReportsModule: GatewazeModule = {
  id: 'event-reports',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Event Reports',
  description: 'Analytics dashboards, attendance reports, and post-event summary generation',
  version: '1.0.0',
  features: [
    'event-reports',
    'event-reports.analytics',
  ],

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/EventReportsTab'),
      order: 110,
      requiredFeature: 'event-reports',
      meta: { tabId: 'reports', label: 'Reports', icon: 'ChartBarIcon' },
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[event-reports] Module installed');
  },

  onEnable: async () => {
    console.log('[event-reports] Module enabled');
  },

  onDisable: async () => {
    console.log('[event-reports] Module disabled');
  },
};

export default eventReportsModule;
