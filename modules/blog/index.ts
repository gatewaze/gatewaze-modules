import type { GatewazeModule } from '@gatewaze/shared';

const blogModule: GatewazeModule = {
  id: 'blog',
  type: 'feature',
  visibility: 'public',
  name: 'Blog',
  description: 'Publish and manage blog posts, categories, and integrated content',
  version: '1.0.0',
  features: [
    'blog',
    'blog.posts',
    'blog.categories',
  ],

  migrations: [
    'migrations/001_blog_tables.sql',
  ],

  adminRoutes: [
    { path: 'blog/posts', component: () => import('./admin/pages/posts/index'), requiredFeature: 'blog', guard: 'none' },
  ],
  adminNavItems: [
    { path: '/blog/posts', label: 'Blog', icon: 'FileText', requiredFeature: 'blog', order: 16 },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[blog] Module installed');
  },

  onEnable: async () => {
    console.log('[blog] Module enabled');
  },

  onDisable: async () => {
    console.log('[blog] Module disabled');
  },
};

export default blogModule;
