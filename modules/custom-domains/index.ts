import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const customDomainsModule: GatewazeModule = {
  id: 'custom-domains',
  type: 'feature',
  visibility: 'public',
  name: 'Custom Domains',
  description: 'Assign custom domains to content items (events, blogs, newsletters) for white-label experiences with automatic DNS verification and TLS certificate provisioning',
  version: '1.0.0',

  features: ['custom_domains'],

  dependencies: [],

  migrations: [
    'migrations/001_custom_domains_table.sql',
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api');
    registerRoutes(app as any, context);
  },

  adminRoutes: [
    {
      path: 'admin/custom-domains',
      component: () => import('./admin/pages/DomainRegistry'),
      requiredFeature: 'custom_domains',
      guard: 'admin',
    },
    {
      path: 'admin/custom-domains/:domainId',
      component: () => import('./admin/pages/DomainDetail'),
      requiredFeature: 'custom_domains',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/admin/custom-domains',
      label: 'Custom Domains',
      icon: 'Globe',
      requiredFeature: 'custom_domains',
      parentGroup: 'admin',
      order: 40,
    },
  ],

  configSchema: {
    cname_target: {
      type: 'string',
      label: 'CNAME Target',
      description: 'The hostname that custom domains should CNAME to (e.g., custom.yourdomain.com)',
      required: true,
    },
    expected_ip: {
      type: 'string',
      label: 'Expected IP Address',
      description: 'The cluster ingress IP address for A record verification',
      required: true,
    },
    cluster_issuer: {
      type: 'string',
      label: 'Cert-Manager Cluster Issuer',
      description: 'The cert-manager ClusterIssuer name for TLS certificates',
      default: 'letsencrypt-prod',
    },
  },

  onInstall: async () => {
    console.log('[custom-domains] Module installed');
  },

  onEnable: async () => {
    console.log('[custom-domains] Module enabled — domain controller will manage DNS verification and TLS provisioning');
  },

  onDisable: async () => {
    console.log('[custom-domains] Module disabled — existing custom domains will remain active but no new domains can be added');
  },
};

export default customDomainsModule;
