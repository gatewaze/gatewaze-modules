import type { GatewazeModule } from '@gatewaze/shared';

const complianceModule: GatewazeModule = {
  id: 'compliance',
  group: 'platform',
  type: 'feature',
  visibility: 'public',
  name: 'Compliance',
  description: 'GDPR, CCPA, and SOC 2 compliance tools — consent records, privacy requests with erasure, data breach tracking, and audit logging',
  version: '1.1.0',
  features: [
    'compliance',
    'compliance.consent',
    'compliance.privacy_requests',
    'compliance.data_breaches',
    'compliance.audit',
  ],

  migrations: [
    'migrations/001_compliance_tables.sql',
    // Erasure engine: registry, identify / plan / execute, suppressions and
    // the subscription guard.
    'migrations/002_erasure_engine.sql',
    // Where personal data lives in core and the open source modules.
    'migrations/003_personal_data_registry.sql',
  ],

  workers: [
    {
      // Preview, erasure, outside services and completion. Uses a direct
      // Postgres connection: the erasure scans tables too large for
      // PostgREST's statement timeout.
      name: 'compliance:erasure',
      handler: './workers/erasure.ts',
      concurrency: 1,
    },
  ],

  crons: [
    {
      // Runs queued previews and erasures (the public API has no job queue on
      // older platforms), and completes requests once manual steps are ticked.
      name: 'compliance-erasure-sweep',
      queue: 'jobs',
      schedule: { pattern: '* * * * *' },
      data: { kind: 'compliance:erasure', action: 'sweep' },
    },
  ],

  apiRoutes: async (app: unknown, ctx?: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerRoutes(app as any, ctx as any);
  },

  publicApiBasePath: '/privacy',

  publicApiScopes: [
    { action: 'read', description: 'Read privacy requests, their status and erasure reports' },
    { action: 'write', description: 'File privacy requests and run their erasure preview' },
    { action: 'erase', description: 'Run an erasure. Deletes personal data; grant deliberately' },
  ],

  publicApiRoutes: async (router, ctx) => {
    const { registerPublicApi } = await import('./public-api');
    registerPublicApi(router as Parameters<typeof registerPublicApi>[0], ctx as Parameters<typeof registerPublicApi>[1]);
  },

  publicApiSchema: {
    tag: { name: 'Privacy', description: 'Data subject requests and erasure (compliance:read / compliance:write / compliance:erase)' },
    paths: {
      '/requests': {
        post: {
          summary: 'File a privacy request for one or more email addresses',
          operationId: 'privacyRequestCreate',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['emails'],
                  properties: {
                    emails: { type: 'array', items: { type: 'string', format: 'email' }, maxItems: 10 },
                    request_type: { type: 'string', enum: ['data_deletion', 'data_export', 'data_correction', 'data_portability', 'consent_withdrawal', 'processing_restriction'], default: 'data_deletion' },
                    source: { type: 'string', description: 'Where the request came from, e.g. a ticket reference' },
                    requested_at: { type: 'string', format: 'date-time', description: 'When the person made the request. Defaults to now.' },
                    due_at: { type: 'string', format: 'date-time', description: 'Defaults to one month after requested_at' },
                    requester_email: { type: 'string', format: 'email' },
                    notes: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 201: { description: 'Created' }, 400: { description: 'Validation error' }, 403: { $ref: '#/components/responses/Forbidden' } },
        },
        get: {
          summary: 'Requests for an email address (exact match)',
          operationId: 'privacyRequestsByEmail',
          parameters: [{ name: 'email', in: 'query', required: true, schema: { type: 'string', format: 'email' } }],
          responses: { 200: { description: 'Matching requests' }, 403: { $ref: '#/components/responses/Forbidden' } },
        },
      },
      '/requests/{id}': {
        get: {
          summary: 'Status, preview and erasure progress',
          operationId: 'privacyRequestGet',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'The request' }, 404: { description: 'Not found' } },
        },
      },
      '/requests/{id}/preview': {
        post: {
          summary: 'Build the erasure preview: what would be removed, per table, and anything blocking it. Changes nothing.',
          operationId: 'privacyRequestPreview',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 202: { description: 'Preview queued; poll the request' }, 409: { description: 'Not a deletion request, or already closed' } },
        },
      },
      '/requests/{id}/execute': {
        post: {
          summary: 'Run the erasure. Needs a fresh preview with no blockers and confirm_email matching one of the request addresses.',
          operationId: 'privacyRequestExecute',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['confirm_email'], properties: { confirm_email: { type: 'string', format: 'email' } } } } },
          },
          responses: { 202: { description: 'Erasure queued; poll the request' }, 409: { description: 'Preview missing, stale or blocked' } },
        },
      },
      '/requests/{id}/report': {
        get: {
          summary: 'Erasure report in Markdown, for the reply to the person',
          operationId: 'privacyRequestReport',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Report' } },
        },
      },
    },
  },

  adminRoutes: [
    {
      path: 'compliance',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'compliance',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/admin/compliance',
      label: 'Compliance',
      icon: 'Shield',
      requiredFeature: 'compliance',
      parentGroup: 'admin',
      order: 30,
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[compliance] Module installed');
  },

  onEnable: async () => {
    console.log('[compliance] Module enabled');
  },

  onDisable: async () => {
    console.log('[compliance] Module disabled');
  },
};

export default complianceModule;
