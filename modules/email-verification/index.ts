import type { GatewazeModule } from '@gatewaze/shared';

/**
 * Email Verification
 *
 * Checks every person's email address before outreach mails it, so bad
 * addresses do not bounce and hurt the sending domain's reputation.
 *
 * On its own the module runs free checks: address format, common domain
 * typos, disposable domains, no-reply addresses, and DNS (does the domain
 * exist and take mail, and does Google, Microsoft or someone else run its
 * inbox). Paid services that check the mailbox itself plug in as separate
 * modules with ids `email-verification-<name>`, each exporting a provider
 * from its `provider.ts` (see lib/types.ts). Several can be enabled at once:
 * in order with fallback, one for catch-all escalation, and one to compare
 * on a sample.
 *
 * Results land in email_verifications and on the person as
 * attributes.email_check (valid, risky, invalid) and email_provider, for
 * segments. Invalid addresses, including real hard bounces, are added to
 * broadcast suppressions.
 */
const emailVerificationModule: GatewazeModule = {
  id: 'email-verification',
  group: 'communications',
  type: 'feature',
  visibility: 'public',
  name: 'Email Verification',
  description:
    'Checks every email address (format, typos, disposable domains, DNS, and optional paid mailbox checks) and keeps bad addresses out of broadcasts.',
  version: '0.1.0',
  features: ['email-verification'],
  // The hard-bounce trigger sits on email_send_log.
  dependencies: ['bulk-emailing'],

  migrations: [
    'migrations/001_email_verification.sql',
  ],

  workers: [
    { name: 'email-verification:tick', handler: './workers/tick.ts' },
  ],

  crons: [
    {
      name: 'email-verification-tick',
      queue: 'jobs',
      // Each run is time-budgeted and batched, so a large first pass spreads
      // across runs without holding a worker slot.
      schedule: { every: 5 * 60_000 },
      data: { kind: 'email-verification:tick' },
    },
  ],

  adminRoutes: [
    {
      path: 'email-verification',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'email-verification',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/email-verification',
      label: 'Email Verification',
      icon: 'BadgeCheck',
      requiredFeature: 'email-verification',
      defaultSection: 'Communications',
      defaultLocation: 'sidebar',
      order: 46,
    },
  ],

  configSchema: {
    daily_paid_limit: {
      key: 'daily_paid_limit',
      type: 'number',
      label: 'Paid checks per day',
      description: 'Most paid checks per day across all provider modules. Default 500. 0 turns paid checks off.',
      required: false,
    },
    provider_order: {
      key: 'provider_order',
      type: 'string',
      label: 'Provider order',
      description: 'Provider modules to try, first choice first, comma separated, e.g. "debounce, kickbox". Empty uses every enabled provider.',
      required: false,
    },
    escalation_provider: {
      key: 'escalation_provider',
      type: 'string',
      label: 'Escalation provider',
      description: 'Provider asked again when the first answer is catch-all or unknown, e.g. "bounceban". Optional.',
      required: false,
    },
    compare_provider: {
      key: 'compare_provider',
      type: 'string',
      label: 'Compare provider',
      description: 'Provider also run on a sample, to compare answers. Its answers never change a result. Optional.',
      required: false,
    },
    compare_percent: {
      key: 'compare_percent',
      type: 'number',
      label: 'Compare sample (%)',
      description: 'Share of checked addresses also sent to the compare provider. Default 0.',
      required: false,
    },
    recheck_days: {
      key: 'recheck_days',
      type: 'number',
      label: 'Check again after (days)',
      description: 'Default 180.',
      required: false,
    },
    checks_per_run: {
      key: 'checks_per_run',
      type: 'number',
      label: 'Addresses per run',
      description: 'Default 500. The worker runs every 5 minutes.',
      required: false,
    },
    suppress_invalid: {
      key: 'suppress_invalid',
      type: 'boolean',
      label: 'Keep invalid addresses out of broadcasts',
      description: 'Adds invalid addresses (and hard bounces) to broadcast suppressions. Default on.',
      required: false,
    },
  },
};

export default emailVerificationModule;
