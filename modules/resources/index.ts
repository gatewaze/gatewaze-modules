import type { GatewazeModule } from '@gatewaze/shared';

const structuredResourcesModule: GatewazeModule = {
  id: 'resources',
  group: 'content',
  type: 'feature',
  visibility: 'premium',
  name: 'Structured Resources',
  description: 'Create and manage hierarchical resource guides with configurable section templates and access control',
  version: '1.0.0',
  features: [
    'resources',
    'resources.collections',
    'resources.import',
  ],

  dependencies: ['content-platform'],

  migrations: [
    'migrations/001_structured_resources.sql',
    'migrations/002_triage_adapter.sql',
    'migrations/003_keyword_adapter.sql',
    'migrations/004_register_with_platform.sql',
    'migrations/005_public_items_view.sql',
  ],

  // Surface public resource items in the unified /api/v1/content feed. The
  // single-table descriptor reads the sr_public_items view (which joins in the
  // collection slug needed for the resource path) — see migration 005.
  publicContentSources: [
    {
      type: 'resource',
      table: 'sr_public_items',
      scope: 'resources:read',
      fields: { id: 'id', title: 'title', date: 'created_at', summary: 'subtitle' },
      resourcePath: (row) => `/resources/items/${row.id}`,
      fullFields: [
        'id', 'title', 'subtitle', 'item_slug', 'collection_slug', 'collection_name',
        'category_name', 'featured_image_url', 'external_url', 'created_at', 'updated_at',
        'content_category',
      ],
    },
  ],

  publicApiScopes: [
    { action: 'read', description: 'Read public resource collections and items' },
  ],

  publicApiRoutes: async (router: unknown, ctx: unknown) => {
    const { registerPublicApi } = await import('./public-api');
    registerPublicApi(router, ctx);
  },

  publicApiSchema: {
    tag: { name: 'Resources', description: 'Public structured-resource items' },
    paths: {
      '/': {
        get: {
          summary: 'List public resource items',
          operationId: 'listResourceItems',
          parameters: [
            { name: 'collection', in: 'query', schema: { type: 'string' }, description: 'Filter by collection slug' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, minimum: 1, maximum: 100 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 } },
          ],
          responses: { 200: { description: 'Paginated list of public resource items' } },
        },
      },
      '/items/{id}': {
        get: {
          summary: 'Get a single public resource item',
          operationId: 'getResourceItem',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Resource item' }, 404: { $ref: '#/components/responses/NotFound' } },
        },
      },
    },
  },

  adminRoutes: [
    {
      path: 'resources/collections',
      component: () => import('./admin/pages/collections/index'),
      requiredFeature: 'resources',
      guard: 'none',
    },
    {
      path: 'resources/collections/:id',
      component: () => import('./admin/pages/collection/index'),
      requiredFeature: 'resources',
      guard: 'none',
    },
    {
      path: 'resources/collections/:id/:tab',
      component: () => import('./admin/pages/collection/index'),
      requiredFeature: 'resources',
      guard: 'none',
    },
    {
      path: 'resources/import',
      component: () => import('./admin/pages/import/index'),
      requiredFeature: 'resources.import',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/resources/collections',
      label: 'Resources',
      icon: 'BookOpen',
      requiredFeature: 'resources',
      order: 18,
    },
  ],

  portalNav: {
    label: 'Resources',
    path: '/resources',
    icon: 'book-open',
    order: 25,
  },

  portalRoutes: [
    { path: '/resources', component: () => import('./portal/pages/index') },
    { path: '/resources/:collectionSlug', component: () => import('./portal/pages/[collectionSlug]/index') },
    { path: '/resources/:collectionSlug/:itemSlug', component: () => import('./portal/pages/[collectionSlug]/[itemSlug]') },
  ],

  configSchema: {
    default_access: {
      type: 'select',
      label: 'Default content access',
      default: 'authenticated',
      options: ['public', 'authenticated'],
      description: 'Default access level for new collections. Individual collections can override this.',
    },
    show_teaser: {
      type: 'boolean',
      label: 'Show teaser to unauthenticated users',
      default: true,
      description: 'When a collection requires auth, show titles and descriptions with a sign-in prompt',
    },
  },

  onInstall: async () => {
    console.log('[resources] Module installed');
  },

  onEnable: async () => {
    console.log('[resources] Module enabled');
  },

  onDisable: async () => {
    console.log('[resources] Module disabled');
  },
};

export default structuredResourcesModule;
