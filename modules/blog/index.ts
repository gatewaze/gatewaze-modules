import type { GatewazeModule } from '@gatewaze/shared';

const blogModule: GatewazeModule = {
  id: 'blog',
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

  migrations: [
    'migrations/001_blog_tables.sql',
    'migrations/002_blog_embeddings.sql',
  ],

  adminRoutes: [
    { path: 'blog/posts', component: () => import('./admin/pages/posts/index'), requiredFeature: 'blog', guard: 'none' },
  ],
  adminNavItems: [
    { path: '/blog/posts', label: 'Blog', icon: 'FileText', requiredFeature: 'blog', order: 16 },
  ],

  portalNav: {
    label: 'Blog',
    path: '/blog',
    icon: 'newspaper',
    order: 20,
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
