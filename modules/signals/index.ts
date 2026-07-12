import type { GatewazeModule } from '@gatewaze/shared';

// Signals — the content-to-audience routing engine (see
// spec: gatewaze-signals-module-proposal.md / gatewaze-environments).
//
// Platform-tier: consumed by content modules rather than being one. It owns
// no identity store, no content store and no send pipeline — it reads the
// platform's profiles + content, scores (person, content) pairs against
// declarative rules, records fires, dispatches them to channel plugins
// (log | webhook | portal_pin | broadcast_draft) and collects outcomes so
// rule tuning has ground truth.

const signalsModule: GatewazeModule = {
  id: 'signals',
  group: 'platform',
  type: 'feature',
  visibility: 'premium',
  name: 'Signals',
  description: 'Continuous content-to-audience routing: rules match content to people and dispatch decisions to channels, with fires and outcomes recorded for tuning',
  version: '0.1.0',
  features: ['signals'],

  dependencies: [],

  migrations: [
    'migrations/001_signals.sql',
    'migrations/002_video_play_outcome.sql',
  ],

  publicApiScopes: [
    { action: 'read', description: 'Read signals rules, fires and telemetry' },
    { action: 'write', description: 'Manage signals rules, run evaluations, record outcomes' },
  ],

  publicApiRoutes: async (router: unknown, ctx: unknown) => {
    const { registerManageApi } = await import('./manage-api');
    registerManageApi(router, ctx);
  },

  publicApiSchema: {
    tag: { name: 'Signals', description: 'Content-to-audience routing engine' },
    paths: {
      '/rules': {
        get: { summary: 'List routing rules (requires signals:write)', operationId: 'listSignalsRules', responses: { 200: { description: 'Rules' } } },
        post: { summary: 'Create a routing rule — lands paused unless status=active (requires signals:write)', operationId: 'createSignalsRule', responses: { 201: { description: 'Created rule' } } },
      },
      '/rules/{id}': {
        patch: { summary: 'Update a rule (activate/pause/edit definition)', operationId: 'updateSignalsRule', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Updated rule' } } },
        delete: { summary: 'Delete a rule and its fires', operationId: 'deleteSignalsRule', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Deleted' } } },
      },
      '/rules/{id}/evaluate': {
        post: { summary: 'Evaluate one rule now (?dry_run=1 to preview without firing)', operationId: 'evaluateSignalsRule', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Evaluation summary' } } },
      },
      '/evaluate-due': {
        post: { summary: 'Evaluate all active rules whose interval has elapsed (?force=1 for all)', operationId: 'evaluateDueSignalsRules', responses: { 200: { description: 'Per-rule summaries' } } },
      },
      '/fires': {
        get: { summary: 'Recent fires (filter by rule_id/status)', operationId: 'listSignalsFires', responses: { 200: { description: 'Fires' } } },
      },
      '/outcomes': {
        post: { summary: 'Record an outcome for a fire', operationId: 'recordSignalsOutcome', responses: { 201: { description: 'Recorded' } } },
      },
      '/stats': {
        get: { summary: 'Per-rule telemetry (fires, dispatch results, outcomes)', operationId: 'signalsStats', responses: { 200: { description: 'Stats' } } },
      },
    },
  },

  adminRoutes: [
    {
      path: 'signals',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'signals',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      // admin-guarded routes mount under the /admin branch of the router
      path: '/admin/signals',
      label: 'Signals',
      icon: 'Radio',
      requiredFeature: 'signals',
      order: 40,
    },
  ],

  configSchema: {
    evaluation_interval_minutes: {
      type: 'number',
      label: 'Default evaluation interval (minutes)',
      default: 1440,
      description: 'How often active rules re-evaluate when the rule itself does not set interval_minutes',
    },
  },

  onInstall: async () => {
    console.log('[signals] Module installed');
  },
  onEnable: async () => {
    console.log('[signals] Module enabled');
  },
  onDisable: async () => {
    console.log('[signals] Module disabled');
  },
};

export default signalsModule;
