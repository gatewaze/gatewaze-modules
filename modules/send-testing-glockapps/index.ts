import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

/**
 * Send Testing — GlockApps
 *
 * Answers the second, different question: not "did it arrive" but "did it land
 * in the inbox". That needs an outside observer sitting in real mailboxes at
 * real providers, which is what a GlockApps seed list is.
 *
 * A separate module on purpose. GlockApps is a paid subscription and most
 * installs will never have one; the core send-testing module has to deliver its
 * whole pipeline-mechanics value without it. This add-on contributes a panel
 * into the core run-detail page through a slot, so the core page simply renders
 * nothing extra when the add-on is absent.
 *
 * Two modes, because GlockApps' API access is plan-gated and the tiering is not
 * reliably documented:
 *   - manual: paste the per-provider numbers from the dashboard. Always works.
 *     This is the committed floor.
 *   - api: start tests and poll results automatically. Requires a plan that
 *     grants API access; degrades to manual on a persistent auth failure.
 *
 * See spec-send-testing-module.md §5.
 */
const sendTestingGlockAppsModule: GatewazeModule = {
  id: 'send-testing-glockapps',
  group: 'communications',
  type: 'integration',
  visibility: 'public',
  name: 'Send Testing — GlockApps',
  description:
    'Inbox-placement reporting for send tests: GlockApps seed addresses on the test list, per-provider Inbox/Tabs/Spam results on the run page.',
  version: '0.1.0',
  features: ['send-testing-glockapps'],

  // The core module owns the list, the runs, and the slot this fills.
  dependencies: ['send-testing'],

  migrations: [
    'migrations/001_placement_reports.sql',
  ],

  workers: [
    { name: 'send-testing-glockapps:poll', handler: './workers/poll-placement.ts' },
  ],

  crons: [
    {
      name: 'send-testing-glockapps-poll',
      queue: 'jobs',
      // Placement results settle over hours, not seconds: seed mailboxes have
      // to actually receive and classify the message. Ten minutes is frequent
      // enough to feel live without hammering a paid API.
      schedule: { every: 600_000 },
      data: { kind: 'send-testing-glockapps:poll' },
    },
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api/register-routes');
    registerRoutes(app as any, context as any);
  },

  adminSlots: [
    {
      slotName: 'send-test-run-detail:panels',
      component: () => import('./admin/components/PlacementPanel'),
      order: 100,
      requiredFeature: 'send-testing-glockapps',
    },
  ],

  adminRoutes: [
    {
      path: 'send-testing/placement',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'send-testing-glockapps',
      guard: 'none',
    },
  ],

  configSchema: {
    api_key: {
      key: 'api_key',
      type: 'secret',
      label: 'GlockApps API key',
      description:
        'Leave blank to run in manual mode (paste results from the dashboard). API access is plan-gated; confirm your plan grants it before relying on automatic mode.',
      required: false,
    },
    seed_list_mode: {
      key: 'seed_list_mode',
      type: 'select',
      label: 'Where seed addresses live',
      description:
        'Shared puts GlockApps seeds on the same Bulk Send Testing list, so one send measures both completion and placement. Separate keeps a placement-only list.',
      required: false,
      default: 'shared',
      options: [
        { label: 'Shared with the test list', value: 'shared' },
        { label: 'Separate placement list', value: 'separate' },
      ],
    },
  },

  onInstall: async () => {
    console.log('[send-testing-glockapps] Module installed');
  },
  onEnable: async () => {
    console.log('[send-testing-glockapps] Module enabled');
  },
  onDisable: async () => {
    console.log('[send-testing-glockapps] Module disabled');
  },
};

export default sendTestingGlockAppsModule;
