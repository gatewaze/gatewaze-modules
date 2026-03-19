import type { GatewazeModule } from '@gatewaze/shared';

const discountsModule: GatewazeModule = {
  id: 'discounts',
  type: 'feature',
  visibility: 'public',
  name: 'Discounts',
  description: 'Create, distribute, and track discount codes for events and products',
  version: '1.0.0',
  features: [
    'discounts',
    'discounts.manage',
    'discounts.claimants',
  ],

  adminRoutes: [
    {
      path: 'discounts',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'discounts',
      guard: 'none',
    },
    {
      path: 'discounts/:eventId/claimants',
      component: () => import('./admin/pages/claimants'),
      requiredFeature: 'discounts',
      guard: 'none',
    },
    {
      path: 'discounts/:eventId/detail',
      component: () => import('./admin/pages/detail'),
      requiredFeature: 'discounts',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/discounts',
      label: 'Discounts',
      icon: 'Tag',
      requiredFeature: 'discounts',
      order: 11,
    },
  ],

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/components/EventDiscountsTab'),
      order: 50,
      requiredFeature: 'discounts',
      meta: { tabId: 'discounts', label: 'Discounts', icon: 'TicketIcon' },
    },
  ],

  migrations: [
    'migrations/000_discounts_core_tables.sql',
    'migrations/001_discounts_tables.sql',
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[discounts] Module installed');
  },

  onEnable: async () => {
    console.log('[discounts] Module enabled');
  },

  onDisable: async () => {
    console.log('[discounts] Module disabled');
  },
};

export default discountsModule;
