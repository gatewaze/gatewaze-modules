import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const formsModule: GatewazeModule = {
  id: 'forms',
  type: 'feature',
  visibility: 'public',
  name: 'Forms',
  description: 'Create custom forms, collect submissions, and associate responses with people records. Supports portal pages, API submission, and embeddable forms.',
  version: '1.0.0',
  features: [
    'forms',
    'forms.create',
    'forms.submissions',
  ],

  migrations: [
    'migrations/001_forms_tables.sql',
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api');
    registerRoutes(app as any, context);
  },

  adminRoutes: [
    { path: 'forms', component: () => import('./admin/pages/index'), requiredFeature: 'forms', guard: 'none' },
    { path: 'forms/:formId', component: () => import('./admin/pages/detail/index'), requiredFeature: 'forms', guard: 'none' },
  ],
  adminNavItems: [
    { path: '/forms', label: 'Forms', icon: 'ClipboardDocumentList', requiredFeature: 'forms', order: 18 },
  ],

  portalRoutes: [
    { path: '/forms/:slug', component: () => import('./portal/pages/_slug') },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[forms] Module installed');
  },

  onEnable: async () => {
    console.log('[forms] Module enabled');
  },

  onDisable: async () => {
    console.log('[forms] Module disabled');
  },
};

export default formsModule;
