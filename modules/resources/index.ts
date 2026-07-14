import type { GatewazeModule } from '@gatewaze/shared';

const structuredResourcesModule: GatewazeModule = {
  id: 'resources',
  group: 'content',
  type: 'feature',
  visibility: 'premium',
  name: 'Structured Resources',
  description: 'Create and manage hierarchical resource guides with configurable section templates and access control',
  version: '1.1.0',
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
    'migrations/006_metered_access.sql',
    'migrations/007_structured_blocks.sql',
    'migrations/008_related_pins.sql',
    'migrations/009_keyword_topics.sql',
    'migrations/010_related_embeddings.sql',
    'migrations/011_related_blog_topics.sql',
    'migrations/012_related_scoring.sql',
    'migrations/013_related_sources.sql',
    'migrations/014_video_related_source.sql',
    'migrations/015_block_transcripts.sql',
    'migrations/016_related_recency.sql',
    'migrations/017_related_type_diversity.sql',
    'migrations/019_sr_items_occurred_at.sql',
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
    { action: 'write', description: 'Create and manage resource collections, categories, items, and sections (drafts included)' },
  ],

  publicApiRoutes: async (router: unknown, ctx: unknown) => {
    const { registerPublicApi } = await import('./public-api');
    registerPublicApi(router, ctx);
    // Management (write-scoped) surface — the programmatic path used by the
    // Gatewaze MCP server's resources_* tools.
    const { registerManageApi } = await import('./manage-api');
    registerManageApi(router, ctx);
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
        patch: {
          summary: 'Update an item, e.g. publish it (requires resources:write)',
          operationId: 'updateResourceItem',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Updated item' }, 404: { $ref: '#/components/responses/NotFound' } },
        },
      },
      '/collections': {
        get: {
          summary: 'List all resource collections (requires resources:write)',
          operationId: 'listResourceCollections',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, minimum: 1, maximum: 100 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 } },
          ],
          responses: { 200: { description: 'Paginated list of collections, drafts included' } },
        },
        post: {
          summary: 'Create a resource collection (requires resources:write)',
          operationId: 'createResourceCollection',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string' },
                    slug: { type: 'string' },
                    description: { type: 'string' },
                    status: { type: 'string', enum: ['draft', 'published', 'archived'], default: 'draft' },
                    access: { type: 'string', enum: ['public', 'authenticated', 'inherit'], default: 'inherit' },
                  },
                },
              },
            },
          },
          responses: { 201: { description: 'Created collection' } },
        },
      },
      '/collections/{id}': {
        get: {
          summary: 'Get a collection with its categories and section templates (requires resources:write)',
          operationId: 'getResourceCollection',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Collection detail' }, 404: { $ref: '#/components/responses/NotFound' } },
        },
        patch: {
          summary: 'Update a collection, e.g. publish it (requires resources:write)',
          operationId: 'updateResourceCollection',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Updated collection' }, 404: { $ref: '#/components/responses/NotFound' } },
        },
      },
      '/collections/{id}/categories': {
        post: {
          summary: 'Create a category in a collection (requires resources:write)',
          operationId: 'createResourceCategory',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 201: { description: 'Created category' }, 404: { $ref: '#/components/responses/NotFound' } },
        },
      },
      '/collections/{id}/templates': {
        post: {
          summary: 'Create a section template in a collection (requires resources:write)',
          operationId: 'createResourceSectionTemplate',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 201: { description: 'Created section template' }, 404: { $ref: '#/components/responses/NotFound' } },
        },
      },
      '/collections/{id}/items': {
        get: {
          summary: 'List a collection\'s items across all statuses (requires resources:write)',
          operationId: 'listResourceCollectionItems',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['draft', 'published', 'archived'] } },
          ],
          responses: { 200: { description: 'Paginated list of items' } },
        },
        post: {
          summary: 'Create an item, optionally with sections (requires resources:write)',
          operationId: 'createResourceItem',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['title', 'category_id'],
                  properties: {
                    title: { type: 'string' },
                    category_id: { type: 'string', format: 'uuid' },
                    subtitle: { type: 'string' },
                    external_url: { type: 'string' },
                    status: { type: 'string', enum: ['draft', 'published', 'archived'], default: 'draft' },
                    sections: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['heading'],
                        properties: {
                          heading: { type: 'string' },
                          content: { type: 'string' },
                          template_id: { type: 'string', format: 'uuid' },
                          sort_order: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: { 201: { description: 'Created item with sections' } },
        },
      },
      '/items/{id}/manage': {
        get: {
          summary: 'Get a full item with sections, any status (requires resources:write)',
          operationId: 'getResourceItemManage',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Item with sections' }, 404: { $ref: '#/components/responses/NotFound' } },
        },
      },
      '/items/{id}/sections': {
        put: {
          summary: 'Replace an item\'s full section list; sections carry content OR typed blocks (requires resources:write)',
          operationId: 'setResourceItemSections',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'Replaced sections (response echoes persisted sections with blocks and the item version)' },
            404: { $ref: '#/components/responses/NotFound' },
            409: { description: 'Version mismatch (if_match) or slug conflict' },
          },
        },
      },
      '/items/{itemId}/sections/{sectionId}/blocks': {
        put: {
          summary: 'Replace one section\'s typed blocks; never touches legacy content (requires resources:write)',
          operationId: 'setResourceSectionBlocks',
          parameters: [
            { name: 'itemId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'sectionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['blocks'],
                  properties: {
                    if_match: { type: 'string', description: 'Optional concurrency token (the item version from GET /items/{id}/manage, echoed verbatim)' },
                    blocks: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['kind', 'data'],
                        properties: {
                          kind: { type: 'string', enum: ['html', 'talk'] },
                          slug: { type: 'string' },
                          sort_order: { type: 'integer' },
                          data: { type: 'object' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Replaced blocks' },
            404: { $ref: '#/components/responses/NotFound' },
            409: { description: 'Version mismatch (if_match) or slug conflict' },
          },
        },
      },
      '/block-kinds': {
        get: {
          summary: 'Registered block kinds with their JSON Schemas (requires resources:write)',
          operationId: 'listResourceBlockKinds',
          responses: { 200: { description: 'Kind definitions' } },
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
    {
      path: 'resources/related-pins',
      component: () => import('./admin/pages/related-pins/index'),
      requiredFeature: 'resources',
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
