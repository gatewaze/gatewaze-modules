import type { GatewazeModule } from '@gatewaze/shared';

/**
 * Content Hub — single admin nav entry that gathers everything content-related
 * (Triage, Library, Rules, Sources) into one tabbed shell.
 *
 * Other modules (content-triage, content-keywords, content-pipeline) contribute
 * sub-tabs via `adminSlots` with slot names `content-hub:inbox`,
 * `content-hub:library`, `content-hub:rules`, `content-hub:sources`.
 */
const contentHubModule: GatewazeModule = {
  id: 'content-hub',
  group: 'content',
  type: 'feature',
  visibility: 'hidden',
  name: 'Content',
  description: 'Unified admin shell for content workflows — triage, library, rules, and sources.',
  version: '1.0.0',
  features: ['content-hub'],

  // No hard dependencies: each tab is contributed via slots and only
  // appears if the contributing module is installed + enabled.
  dependencies: [],

  adminRoutes: [
    { path: 'content',                       component: () => import('./admin/pages/ContentShell'), requiredFeature: 'content-hub', guard: 'admin' },
    { path: 'content/:section',              component: () => import('./admin/pages/ContentShell'), requiredFeature: 'content-hub', guard: 'admin' },
    { path: 'content/:section/:tab',         component: () => import('./admin/pages/ContentShell'), requiredFeature: 'content-hub', guard: 'admin' },
    { path: 'content/:section/:tab/*',       component: () => import('./admin/pages/ContentShell'), requiredFeature: 'content-hub', guard: 'admin' },
  ],

  adminNavItems: [
    {
      path: '/admin/content',
      label: 'Content',
      icon: 'Library',
      requiredFeature: 'content-hub',
      parentGroup: 'admin',
      order: 30,
    },
  ],

  configSchema: {},
};

export default contentHubModule;
