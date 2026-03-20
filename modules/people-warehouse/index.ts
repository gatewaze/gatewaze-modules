import type { GatewazeModule } from '@gatewaze/shared';

const peopleWarehouseModule: GatewazeModule = {
  id: 'people-warehouse',
  type: 'integration',
  group: 'integration',
  visibility: 'public',
  name: 'People Warehouse',
  description:
    'Bi-directional sync of people data with Customer.io — automatically push new contacts, sync attributes, and import segment membership',
  version: '1.0.0',
  features: [
    'people_warehouse',
    'people_warehouse.sync',
    'people_warehouse.segments',
    'people_warehouse.tracking',
  ],

  dependencies: ['customerio'],

  edgeFunctions: [
    'integrations-customerio-sync',
    'integrations-customerio-sync-person',
    'integrations-customerio-process-events',
    'integrations-track-event',
    'integrations-customerio-webhook',
  ],

  configSchema: {
    CUSTOMERIO_SITE_ID: {
      key: 'CUSTOMERIO_SITE_ID',
      type: 'string',
      required: true,
      description: 'Customer.io Track API site identifier',
    },
    CUSTOMERIO_API_KEY: {
      key: 'CUSTOMERIO_API_KEY',
      type: 'secret',
      required: true,
      description: 'Customer.io Track API key for sending data',
    },
    CUSTOMERIO_APP_API_KEY: {
      key: 'CUSTOMERIO_APP_API_KEY',
      type: 'secret',
      required: true,
      description: 'Customer.io App API key for reading segments and customers',
    },
    SYNC_ON_CREATE: {
      key: 'SYNC_ON_CREATE',
      type: 'boolean',
      required: false,
      default: 'true',
      description: 'Automatically sync new people to Customer.io when created',
    },
    SYNC_ON_UPDATE: {
      key: 'SYNC_ON_UPDATE',
      type: 'boolean',
      required: false,
      default: 'true',
      description: 'Automatically sync attribute changes to Customer.io',
    },
    IMPORT_SEGMENTS: {
      key: 'IMPORT_SEGMENTS',
      type: 'boolean',
      required: false,
      default: 'true',
      description: 'Import Customer.io segments and sync membership',
    },
  },

  onInstall: async () => {
    console.log('[people-warehouse] Module installed');
  },

  onEnable: async () => {
    console.log('[people-warehouse] Module enabled');
  },

  onDisable: async () => {
    console.log('[people-warehouse] Module disabled');
  },
};

export default peopleWarehouseModule;
