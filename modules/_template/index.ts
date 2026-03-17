/**
 * Template module — copy this directory to create a new Gatewaze module.
 *
 * 1. Copy _template/ to a new directory (e.g., my-feature/)
 * 2. Update package.json with your module's name and dependencies
 * 3. Update this file with your module's routes, nav items, etc.
 * 4. Add SQL migrations in migrations/
 * 5. Add admin UI components in admin/
 */

import type { GatewazeModule } from '@gatewaze/shared';

const templateModule: GatewazeModule = {
  id: 'template',
  name: 'Template Module',
  description: 'A starting point for building Gatewaze modules',
  version: '1.0.0',
  features: ['template.view'],

  adminRoutes: [
    {
      path: '/template',
      component: () => import('./admin/ExamplePage'),
      requiredFeature: 'template.view',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/template',
      label: 'Template',
      icon: 'Puzzle',
      requiredFeature: 'template.view',
      parentGroup: 'dashboards',
      order: 100,
    },
  ],

  migrations: [
    './migrations/001_example.sql',
  ],

  configSchema: {
    exampleSetting: {
      key: 'exampleSetting',
      type: 'string',
      required: false,
      default: 'hello',
      description: 'An example configuration value',
    },
  },

  onInstall: async () => {
    console.log('[template] Module installed');
  },

  onEnable: async () => {
    console.log('[template] Module enabled');
  },

  onDisable: async () => {
    console.log('[template] Module disabled');
  },
};

export default templateModule;
