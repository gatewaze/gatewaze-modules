import type { GatewazeModule } from '@gatewaze/shared';

const competitionsModule: GatewazeModule = {
  id: 'competitions',
  type: 'feature',
  visibility: 'public',
  name: 'Competitions',
  description: 'Run competitions with entry submissions, judging workflows, and winner selection',
  version: '1.0.0',
  features: [
    'competitions',
    'competitions.entries',
    'competitions.judging',
  ],

  adminRoutes: [
    {
      path: 'competitions',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'competitions',
      guard: 'none',
    },
    {
      path: 'competitions/:competitionId/entries',
      component: () => import('./admin/pages/entries'),
      requiredFeature: 'competitions',
      guard: 'none',
    },
    {
      path: 'competitions/:competitionId/detail',
      component: () => import('./admin/pages/detail'),
      requiredFeature: 'competitions',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/competitions',
      label: 'Competitions',
      icon: 'Trophy',
      requiredFeature: 'competitions',
      order: 10,
    },
  ],

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/components/EventCompetitionsTab'),
      order: 40,
      requiredFeature: 'competitions',
      meta: { tabId: 'competitions', label: 'Competitions', icon: 'TrophyIcon' },
    },
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/components/EventMatchingTab'),
      order: 100,
      requiredFeature: 'competitions',
      meta: { tabId: 'matching', label: 'Matching', icon: 'SwatchIcon' },
    },
  ],

  edgeFunctions: [
    'events-competition-entry',
  ],

  migrations: [
    'migrations/001_competitions_tables.sql',
  ],

  dependencies: ['event-sponsors', 'discounts'],

  configSchema: {},

  onInstall: async () => {
    console.log('[competitions] Module installed');
  },

  onEnable: async () => {
    console.log('[competitions] Module enabled');
  },

  onDisable: async () => {
    console.log('[competitions] Module disabled');
  },
};

export default competitionsModule;
