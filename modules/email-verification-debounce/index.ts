import type { GatewazeModule } from '@gatewaze/shared';

/**
 * Email Verification: Debounce
 *
 * Adds Debounce mailbox checks to the email-verification module. The core
 * module finds this provider by its id prefix and loads ./provider.ts; this
 * module only holds the API key and settings.
 */
const debounceVerificationModule: GatewazeModule = {
  id: 'email-verification-debounce',
  group: 'communications',
  type: 'integration',
  visibility: 'public',
  name: 'Email Verification: Debounce',
  description: 'Debounce mailbox checks for Email Verification: does the mailbox exist, is it a catch-all, spam trap or disposable address.',
  version: '0.1.0',
  features: ['email-verification-debounce'],
  dependencies: ['email-verification'],
  migrations: [],

  configSchema: {
    DEBOUNCE_API_KEY: {
      key: 'DEBOUNCE_API_KEY',
      type: 'secret',
      encrypted: true,
      label: 'Debounce API key',
      description: 'A private key from the Debounce dashboard (API section). Not a public_ key.',
      required: true,
    },
    daily_limit: {
      key: 'daily_limit',
      type: 'number',
      label: 'Checks per day',
      description: 'Most Debounce checks per day. Optional; the Email Verification module also has a limit across all providers.',
      required: false,
    },
    gsuite: {
      key: 'gsuite',
      type: 'boolean',
      label: 'Detect Google Workspace catch-alls',
      description: "Ask Debounce to detect Google Workspace domains that accept any address (its gsuite option).",
      required: false,
    },
  },
};

export default debounceVerificationModule;
