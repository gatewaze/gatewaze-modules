import type { GatewazeModule } from '@gatewaze/shared';

/**
 * Residential Egress — a shared capability that routes IP-gated outbound
 * fetches (starting with YouTube captions) through a residential/ISP proxy so
 * the datacenter/cloud worker isn't served empty or blocked responses.
 *
 * This module owns ONE thing: which provider + what credentials. Consumers
 * (conference-recap, gatewaze-fetch, scrapers) read this config via
 * `lib/egress.ts` and build their own per-fetch proxy dispatcher — a fresh
 * session per fetch = a fresh residential IP, so a throttled/flagged IP is
 * escaped by rotating, not by waiting. See spec-residential-egress-proxy.md.
 *
 * Credentials live in `installed_modules.config` (consistent with the LFID/AI
 * modules), entered by an operator in the settings UI below.
 */
const residentialEgressModule: GatewazeModule = {
  id: 'residential-egress',
  type: 'integration',
  visibility: 'hidden',
  group: 'platform',
  name: 'Residential Egress',
  description:
    'Route IP-gated fetches (e.g. YouTube captions) through a residential proxy provider. Pick a provider, add your credentials, and consumers opt in per target.',
  version: '1.0.0',
  features: ['residential-egress'],

  // Operator-facing settings form. The provider dropdown selects the auth
  // convention; the credentials are the operator's own account (we never ship
  // a key). Blank host/port fall back to the provider's default gateway.
  configSchema: {
    provider: {
      key: 'provider',
      type: 'select',
      required: true,
      default: 'none',
      label: 'Provider',
      description: 'Residential proxy provider. "None" disables egress (consumers use their direct path).',
      options: [
        { label: 'None (disabled)', value: 'none' },
        { label: 'DataImpulse', value: 'dataimpulse' },
        { label: 'Rayobyte', value: 'rayobyte' },
        { label: 'Bright Data', value: 'brightdata' },
        { label: 'Oxylabs', value: 'oxylabs' },
        { label: 'Webshare', value: 'webshare' },
        { label: 'IPRoyal', value: 'iproyal' },
        { label: 'Decodo (Smartproxy)', value: 'decodo' },
      ],
    },
    proxy_username: {
      key: 'proxy_username',
      type: 'secret',
      required: false,
      label: 'Proxy username / login',
      description: 'The proxy login from your provider (Bright Data: your customer id).',
    },
    proxy_password: {
      key: 'proxy_password',
      type: 'secret',
      required: false,
      label: 'Proxy password',
      description: 'The proxy password from your provider.',
    },
    gateway_host: {
      key: 'gateway_host',
      type: 'string',
      required: false,
      label: 'Gateway host (optional)',
      description: 'Override the provider default gateway host (e.g. gw.dataimpulse.com). Blank = provider default.',
    },
    gateway_port: {
      key: 'gateway_port',
      type: 'number',
      required: false,
      label: 'Gateway port (optional)',
      description: 'Override the provider default gateway port (e.g. 823). Blank = provider default.',
      min: 1,
    },
    zone: {
      key: 'zone',
      type: 'string',
      required: false,
      label: 'Zone (Bright Data only)',
      description: 'Bright Data zone name. Ignored by other providers.',
    },
    default_country: {
      key: 'default_country',
      type: 'string',
      required: false,
      label: 'Default country (optional)',
      description: 'ISO alpha-2 code to pin exit IPs to a country (e.g. us). Blank = any country.',
    },
    session_minutes: {
      key: 'session_minutes',
      type: 'number',
      required: false,
      default: '10',
      label: 'Sticky session minutes',
      description: 'How long a sticky session holds one exit IP, where the provider honours it.',
      min: 1,
    },
    daily_gb_cap: {
      key: 'daily_gb_cap',
      type: 'number',
      required: false,
      default: '10',
      label: 'Daily bandwidth cap (GB)',
      description: 'Soft cap on residential proxy bandwidth per day (advisory; provider invoice is authoritative).',
      min: 0,
    },
    host_allowlist: {
      key: 'host_allowlist',
      type: 'string',
      required: false,
      default: 'youtube.com,youtu.be,googlevideo.com',
      label: 'Host allowlist',
      description:
        'Comma-separated host suffixes egress is permitted for. Keeps metered bandwidth scoped to targets that actually IP-gate. Blank = allow all (not recommended).',
    },
  },

  onInstall: async () => {
    console.log('[residential-egress] Module installed');
  },
  onEnable: async () => {
    console.log('[residential-egress] Module enabled');
  },
  onDisable: async () => {
    console.log('[residential-egress] Module disabled');
  },
};

export default residentialEgressModule;
