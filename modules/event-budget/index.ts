import type { GatewazeModule } from '@gatewaze/shared';

const eventBudgetModule: GatewazeModule = {
  id: 'event-budget',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Event Budget',
  description: 'Budget management with categories, allocations, line items, suppliers, and revenue tracking for events',
  version: '1.0.0',
  features: [
    'event-budget',
    'event-budget.categories',
    'event-budget.allocations',
    'event-budget.line-items',
    'event-budget.suppliers',
    'event-budget.revenue',
    'event-budget.reporting',
  ],

  migrations: [
    'migrations/000_event_budget_core_tables.sql',
    'migrations/001_event_budget_tables.sql',
  ],

  adminRoutes: [
    { path: 'budget-categories', component: () => import('./admin/pages/budget-categories'), requiredFeature: 'event-budget', guard: 'admin' },
  ],
  adminNavItems: [
    { path: '/admin/budget-categories', label: 'Budget Categories', icon: 'DollarSign', requiredFeature: 'event-budget', parentGroup: 'admin', order: 22 },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[event-budget] Module installed');
  },

  onEnable: async () => {
    console.log('[event-budget] Module enabled');
  },

  onDisable: async () => {
    console.log('[event-budget] Module disabled');
  },
};

export default eventBudgetModule;
