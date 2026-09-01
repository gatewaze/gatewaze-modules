import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

/**
 * Send Testing
 *
 * Rehearses a large send at close to real scale and answers the mechanical
 * question: did every recipient get processed, how long did the batch take, and
 * where did it stall.
 *
 * The module deliberately owns NO send path. It provisions synthetic recipients
 * as ordinary people rows on an ordinary list, so any sender — broadcasts,
 * newsletters, or an external system fed from the CSV export — targets them
 * through its normal list selection. What gets tested is therefore the
 * production pipeline itself, not a parallel harness that could drift from it.
 *
 * Inbox placement is a different question (reputation, not mechanics) and lives
 * in the optional send-testing-glockapps add-on, because not every install has
 * a GlockApps account.
 *
 * See spec-send-testing-module.md.
 */
const sendTestingModule: GatewazeModule = {
  id: 'send-testing',
  group: 'communications',
  type: 'feature',
  visibility: 'public',
  name: 'Send Testing',
  description:
    'Rehearse a large send: synthetic recipients on a dedicated list, real-arrival measurement via Inbound Parse, completion and latency reporting per run.',
  version: '0.1.0',
  features: [
    'send-testing',
    'send-testing.provision',
    'send-testing.runs',
  ],

  // lists owns the lists/list_subscriptions tables that migration 001 seeds into.
  dependencies: ['lists'],

  migrations: [
    'migrations/001_send_testing_list.sql',
    // 002 adds runs, arrivals, and the singleton provisioning-job row.
    'migrations/002_send_test_runs.sql',
    // 003 adds the domain-guarded provisioning/attribution RPCs. These exist
    // because people_import_batch is gated on is_admin(), which a service-role
    // worker can never satisfy.
    'migrations/003_provision_rpcs.sql',
  ],

  edgeFunctions: ['send-test-inbound'],

  workers: [
    { name: 'send-testing:provision', handler: './workers/provision.ts' },
    { name: 'send-testing:attribute', handler: './workers/attribute.ts' },
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api/register-routes');
    registerRoutes(app as any, context as any);
  },

  adminRoutes: [
    {
      path: 'send-testing',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'send-testing',
      guard: 'none',
    },
    {
      path: 'send-testing/runs/:id',
      component: () => import('./admin/pages/run'),
      requiredFeature: 'send-testing.runs',
      guard: 'none',
    },
    {
      path: 'send-testing/inbox/:email',
      component: () => import('./admin/pages/inbox'),
      requiredFeature: 'send-testing',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/send-testing',
      label: 'Send Testing',
      icon: 'Beaker',
      requiredFeature: 'send-testing',
      defaultSection: 'Communications',
      defaultLocation: 'sidebar',
      order: 40,
    },
  ],

  configSchema: {
    inbound_domain: {
      key: 'inbound_domain',
      type: 'string',
      label: 'Inbound test domain',
      description:
        'Domain whose MX records point at SendGrid Inbound Parse, e.g. sendtest.example.org. Every synthetic address lives here. Nothing can be provisioned until it is set.',
      required: true,
      validationRegex: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$',
    },
    inbound_token: {
      key: 'inbound_token',
      type: 'secret',
      label: 'Inbound URL token',
      description:
        'Shared secret embedded in the Inbound Parse URL. Inbound Parse has no request signing, so this is the only authentication the receiver can have.',
      required: true,
    },
    default_population_size: {
      key: 'default_population_size',
      type: 'number',
      label: 'Default population size',
      description: 'Pre-filled target when provisioning test people.',
      required: false,
      default: '25000',
      min: 1,
    },
    timezone_distribution: {
      key: 'timezone_distribution',
      type: 'string',
      label: 'Timezone distribution (JSON)',
      description:
        'IANA zone to relative weight, e.g. {"Europe/London":15,"UTC":10}. Drives attributes.timezone so timezone-aware sends fan out across a realistic spread. Leave blank for the built-in default.',
      required: false,
    },
    inspectable_count: {
      key: 'inspectable_count',
      type: 'number',
      label: 'Inspectable recipients',
      description:
        'How many of the lowest-numbered test people keep the delivered HTML, so their messages can be opened and their unsubscribe links clicked. Keep small: this is the only body storage.',
      required: false,
      default: '20',
      min: 0,
    },
    postmaster_url: {
      key: 'postmaster_url',
      type: 'string',
      label: 'Google Postmaster Tools URL',
      description: 'Link out for ongoing Gmail reputation. Postmaster needs no test recipients, only a DNS-verified sending domain.',
      required: false,
    },
    snds_url: {
      key: 'snds_url',
      type: 'string',
      label: 'Microsoft SNDS URL',
      description: 'Link out for ongoing Outlook reputation. SNDS needs no test recipients, only registered sending IPs.',
      required: false,
    },
  },

  onInstall: async () => {
    console.log('[send-testing] Module installed');
  },
  onEnable: async () => {
    console.log('[send-testing] Module enabled');
  },
  onDisable: async () => {
    console.log('[send-testing] Module disabled');
  },
};

export default sendTestingModule;
