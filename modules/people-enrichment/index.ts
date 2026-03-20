import type { GatewazeModule } from '@gatewaze/shared';

const peopleEnrichmentModule: GatewazeModule = {
  id: 'people-enrichment',
  type: 'integration',
  group: 'integration',
  visibility: 'public',
  name: 'People Enrichment',
  description:
    'Automatically enrich people records with professional and company data using Clearbit, EnrichLayer, and other providers',
  version: '1.0.0',
  features: [
    'people_enrichment',
    'people_enrichment.auto',
    'people_enrichment.manual',
  ],

  edgeFunctions: ['people-enrichment'],

  configSchema: {
    CLEARBIT_API_KEY: {
      key: 'CLEARBIT_API_KEY',
      type: 'secret',
      required: false,
      description: 'Clearbit API key for person & company enrichment',
    },
    ENRICHLAYER_API_KEY: {
      key: 'ENRICHLAYER_API_KEY',
      type: 'secret',
      required: false,
      description: 'EnrichLayer API key for LinkedIn-based enrichment',
    },
    AUTO_ENRICH_ON_CREATE: {
      key: 'AUTO_ENRICH_ON_CREATE',
      type: 'boolean',
      required: false,
      default: 'true',
      description: 'Automatically enrich new people when they are created',
    },
    ENRICHMENT_MODE: {
      key: 'ENRICHMENT_MODE',
      type: 'string',
      required: false,
      default: 'full',
      description: 'Enrichment mode: "initial" (LinkedIn URL only), "full" (all providers)',
    },
  },

  onInstall: async () => {
    console.log('[people-enrichment] Module installed');
  },

  onEnable: async () => {
    console.log('[people-enrichment] Module enabled');
  },

  onDisable: async () => {
    console.log('[people-enrichment] Module disabled');
  },
};

export default peopleEnrichmentModule;
