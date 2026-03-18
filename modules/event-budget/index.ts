import type { GatewazeModule } from '@gatewaze/shared';

const eventBudgetModule: GatewazeModule = {
  id: 'event-budget',
  type: 'feature',
  visibility: 'public',
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
    'migrations/001_event_budget_tables.sql',
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
