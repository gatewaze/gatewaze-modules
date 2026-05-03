import type { GatewazeModule } from '@gatewaze/shared';

const newslettersModule: GatewazeModule = {
  id: 'newsletters',
  type: 'feature',
  visibility: 'public',
  name: 'Newsletters',
  description: 'Create, edit, and distribute newsletters with edition management and subscriber tracking',
  version: '1.0.0',
  features: [
    'newsletters',
    'newsletters.editor',
    'newsletters.editions',
    'newsletters.subscribers',
    'newsletters.templates',
    'newsletters.sending',
  ],

  edgeFunctions: [
    'newsletter-send',
    'newsletter-unsubscribe',
    'newsletter-gdoc-import',
    'email-inbound-parse',
    'helix-task-create',
    'helix-task-embed-url',
    'newsletter-helix-output-sync',
  ],

  workers: [
    {
      name: 'newsletter:helix-output-sync',
      handler: './workers/helix-output-sync.ts',
    },
  ],

  crons: [
    {
      name: 'newsletter-helix-output-sync',
      queue: 'jobs',
      schedule: { every: 60_000 },
      data: { kind: 'newsletter:helix-output-sync' },
    },
    {
      // Per spec-content-modules-git-architecture §15.4: snapshot editions
      // <snapshot_delay_days> days post-send. Job is idempotent; running
      // every 5 min picks up due editions promptly without spam.
      name: 'newsletter-edition-snapshot',
      queue: 'jobs',
      schedule: { every: 5 * 60_000 },
      data: { kind: 'newsletter:edition-snapshot' },
    },
  ],

  dependencies: ['content-platform'],

  migrations: [
    'migrations/001_newsletters_tables.sql',
    'migrations/002_template_collections_and_sends.sql',
    'migrations/003_brick_block_association.sql',
    'migrations/004_content_category.sql',
    'migrations/005_ai_summary_block.sql',
    'migrations/006_newsletter_types.sql',
    'migrations/007_edition_block_template_fk.sql',
    'migrations/008_add_sort_order_columns.sql',
    'migrations/009_collection_accent_category.sql',
    'migrations/010_setup_complete.sql',
    'migrations/011_require_login.sql',
    'migrations/012_gdoc_import.sql',
    'migrations/013_portal_anon_rls.sql',
    'migrations/014_require_login_rls.sql',
    'migrations/015_replies.sql',
    'migrations/016_triage_adapter.sql',
    'migrations/017_keyword_adapter.sql',
    'migrations/018_register_with_platform.sql',
    'migrations/019_edition_blocks_realtime.sql',
    'migrations/024_editions_snapshot_columns.sql',
  ],

  adminRoutes: [
    // Newsletter list & creation
    { path: 'newsletters', component: () => import('./admin/pages/list'), requiredFeature: 'newsletters', guard: 'none' },
    { path: 'newsletters/new', component: () => import('./admin/components/NewsletterSetupWizard'), requiredFeature: 'newsletters', guard: 'none' },

    // Newsletter detail (hero + tabs: details, template, editions, stats)
    { path: 'newsletters/:slug', component: () => import('./admin/pages/detail'), requiredFeature: 'newsletters', guard: 'none' },
    { path: 'newsletters/:slug/:tab', component: () => import('./admin/pages/detail'), requiredFeature: 'newsletters', guard: 'none' },

    // Edition editor (within a newsletter)
    { path: 'newsletters/:slug/editions/:id', component: () => import('./admin/pages/editions/[id]'), requiredFeature: 'newsletters', guard: 'none' },
    { path: 'newsletters/:slug/editions/:id/:tab', component: () => import('./admin/pages/editions/[id]'), requiredFeature: 'newsletters', guard: 'none' },

    // Legacy edition editor routes (backward compatibility)
    { path: 'newsletters/editor/:id', component: () => import('./admin/pages/editions/[id]'), requiredFeature: 'newsletters', guard: 'none' },
    { path: 'newsletters/editor/:id/:tab', component: () => import('./admin/pages/editions/[id]'), requiredFeature: 'newsletters', guard: 'none' },

    // Template management (still accessible directly for power users)
    { path: 'newsletters/templates', component: () => import('./admin/pages/templates/index'), requiredFeature: 'newsletters.templates', guard: 'none' },
    { path: 'newsletters/templates/:collectionSlug', component: () => import('./admin/pages/templates/[collectionSlug]'), requiredFeature: 'newsletters.templates', guard: 'none' },
    { path: 'newsletters/templates/:collectionSlug/blocks/:blockType', component: () => import('./admin/pages/templates/block-editor'), requiredFeature: 'newsletters.templates', guard: 'none' },
    { path: 'newsletters/templates/:collectionSlug/bricks/:brickType', component: () => import('./admin/pages/templates/brick-editor'), requiredFeature: 'newsletters.templates', guard: 'none' },
    { path: 'newsletters/templates/:collectionSlug/upload', component: () => import('./admin/pages/templates/upload'), requiredFeature: 'newsletters.templates', guard: 'none' },

    // Send management
    { path: 'newsletters/sends', component: () => import('./admin/pages/sends/index'), requiredFeature: 'newsletters.sending', guard: 'none' },
    { path: 'newsletters/sends/:id', component: () => import('./admin/pages/sends/[id]'), requiredFeature: 'newsletters.sending', guard: 'none' },
  ],
  adminNavItems: [
    { path: '/newsletters', label: 'Newsletters', icon: 'Newspaper', requiredFeature: 'newsletters', order: 16 },
  ],

  portalNav: {
    label: 'Newsletters',
    path: '/newsletters',
    icon: 'newspaper',
    order: 30,
  },

  portalRoutes: [
    { path: '/newsletters', component: () => import('./portal/pages/index') },
    { path: '/newsletters/:slug/:date', component: () => import('./portal/pages/_date') },
  ],

  publicApiScopes: [
    { action: 'read', description: 'Read published newsletter editions and types' },
  ],

  publicApiRoutes: async (router: unknown, ctx: any) => {
    const { registerPublicApi } = await import('./public-api');
    registerPublicApi(router, ctx);
  },

  publicApiSchema: {
    tag: { name: 'Newsletters', description: 'Newsletter types and published editions' },
    paths: {
      '/': {
        get: {
          summary: 'List newsletter types',
          operationId: 'listNewsletters',
          parameters: [
            { name: 'content_category', in: 'query', schema: { type: 'string' }, description: 'Filter by category slug (comma-separated for multiple)' },
            { name: 'fields', in: 'query', schema: { type: 'string' }, description: 'Comma-separated field allowlist' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, minimum: 1, maximum: 100 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 } },
          ],
          responses: { 200: { description: 'List of newsletter types' } },
        },
      },
      '/{slug}': {
        get: {
          summary: 'Get a newsletter type by slug',
          operationId: 'getNewsletter',
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Newsletter type' }, 404: { $ref: '#/components/responses/NotFound' } },
        },
      },
      '/{slug}/editions': {
        get: {
          summary: 'List published editions for a newsletter type',
          operationId: 'listNewsletterEditions',
          parameters: [
            { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Editions on or after this date' },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Editions on or before this date' },
            { name: 'content_category', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 100 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          ],
          responses: { 200: { description: 'Published editions' } },
        },
      },
      '/editions/{id}': {
        get: {
          summary: 'Get a single edition by ID',
          operationId: 'getNewsletterEdition',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Edition metadata' }, 404: { $ref: '#/components/responses/NotFound' } },
        },
      },
      '/editions/{id}/content': {
        get: {
          summary: 'Get full block + brick content for an edition',
          operationId: 'getNewsletterEditionContent',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Edition content with ordered blocks and bricks' } },
        },
      },
    },
  },

  publicContentSources: [
    {
      type: 'newsletter_edition',
      table: 'newsletters_editions',
      scope: 'newsletters:read',
      fields: { id: 'id', title: 'title', date: 'edition_date', summary: 'preheader' },
      visibilityFilter: [{ column: 'status', eq: 'published' }],
      resourcePath: (row) => `/newsletters/editions/${row.id}`,
      // Mirrors PUBLIC_EDITION_FIELDS in public-api.ts.
      fullFields: [
        'id', 'title', 'edition_date', 'preheader', 'content_category',
        'collection_id', 'created_at', 'updated_at',
      ],
    },
  ],

  configSchema: {
    GOOGLE_CLIENT_ID: {
      key: 'GOOGLE_CLIENT_ID',
      type: 'string',
      required: false,
      description: 'Google OAuth client ID for Google Docs import (shared with google-sheets module if installed)',
    },
    GOOGLE_CLIENT_SECRET: {
      key: 'GOOGLE_CLIENT_SECRET',
      type: 'secret',
      required: false,
      description: 'Google OAuth client secret',
    },
    GOOGLE_REFRESH_TOKEN: {
      key: 'GOOGLE_REFRESH_TOKEN',
      type: 'secret',
      required: false,
      description: 'Google OAuth refresh token with Docs and Drive read scopes',
    },
    ANTHROPIC_API_KEY: {
      key: 'ANTHROPIC_API_KEY',
      type: 'secret',
      required: false,
      description: 'Claude API key for AI-powered Google Doc section mapping during import',
    },
    HELIX_URL: {
      key: 'HELIX_URL',
      type: 'secret',
      required: false,
      description: 'Helix instance URL for AI content research (e.g. https://meta.helix.ml). Marked secret so resolveModuleSecrets syncs it into the Supabase project secrets table — helix-task-create reads it via Deno.env.get() at edge-function runtime.',
    },
    HELIX_API_KEY: {
      key: 'HELIX_API_KEY',
      type: 'secret',
      required: false,
      description: 'Helix API key for creating research tasks',
    },
    HELIX_PROJECT_ID: {
      key: 'HELIX_PROJECT_ID',
      type: 'secret',
      required: false,
      description: 'Helix project ID for research tasks. Marked secret so the edge function can read it via Deno.env.get().',
    },
    HELIX_ORG_SLUG: {
      key: 'HELIX_ORG_SLUG',
      type: 'secret',
      required: false,
      description: 'Helix organization slug for building task URLs (e.g. "helix"). Marked secret so the edge function can read it via Deno.env.get().',
    },
  },

  onInstall: async () => {
    console.log('[newsletters] Module installed');
  },

  onEnable: async () => {
    console.log('[newsletters] Module enabled');
  },

  onDisable: async () => {
    console.log('[newsletters] Module disabled');
  },
};

export default newslettersModule;
