import type { GatewazeModule } from '@gatewaze/shared';

const blogModule: GatewazeModule = {
  id: 'blog',
  group: 'content',
  type: 'feature',
  visibility: 'public',
  name: 'Blog',
  description: 'Publish and manage blog posts, categories, and integrated content',
  version: '1.2.0',
  features: [
    'blog',
    'blog.posts',
    'blog.categories',
  ],

  dependencies: ['content-platform'],

  migrations: [
    'migrations/001_blog_tables.sql',
    'migrations/002_blog_embeddings.sql',
    'migrations/004_triage_adapter.sql',
    'migrations/005_keyword_adapter.sql',
    'migrations/006_register_with_platform.sql',
    'migrations/007_webhook_topic.sql',
  ],

  adminRoutes: [
    { path: 'blog/posts', component: () => import('./admin/pages/posts/index'), requiredFeature: 'blog', guard: 'none' },
  ],
  adminNavItems: [
    { path: '/blog/posts', label: 'Blog', icon: 'FileText', requiredFeature: 'blog', defaultSection: 'Content', defaultLocation: 'sidebar', order: 20 },
  ],

  apiRoutes: async (app: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRoutes(app as any);
  },

  portalNav: {
    label: 'Blog',
    path: '/blog',
    icon: 'newspaper',
    order: 20,
  },
  // Workspace-shell rail item (spec-portal-workspace-shell.md §8). Public top-level module.
  portalShell: {
    rail: { label: 'Blog', full: 'Blog', icon: 'pencil', order: 20, visibility: 'public' },
    nav: [],
    publicNav: [],
  },

  portalRoutes: [
    { path: '/blog', component: () => import('./portal/pages/index') },
    { path: '/blog/:slug', component: () => import('./portal/pages/_slug') },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[blog] Module installed');
  },

  onEnable: async () => {
    console.log('[blog] Module enabled — setting portal_nav');
  },

  onDisable: async () => {
    console.log('[blog] Module disabled');
  },
};

export default blogModule;
