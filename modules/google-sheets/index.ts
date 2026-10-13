import type { GatewazeModule } from '@gatewaze/shared';

const googleSheetsModule: GatewazeModule = {
  id: 'google-sheets',
  group: 'integrations',
  type: 'integration',
  visibility: 'public',
  name: 'Google Sheets Integration',
  description: 'Sync registration and speaker data to Google Sheets with OAuth and real-time notifications',
  version: '1.0.2',
  features: [
    'google-sheets.sync',
    'google-sheets.oauth',
    'google-sheets.notifications',
  ],

  dependencies: ['events'],

  edgeFunctions: [
    'integrations-google-sheets-notify',
    'integrations-google-sheets-oauth',
  ],

  migrations: [
    'migrations/001_google_sheets_tables.sql',
    'migrations/002_event_admin_rls_and_token_privileges.sql',
  ],

  configSchema: {
    GOOGLE_SHEETS_CLIENT_ID: {
      key: 'GOOGLE_SHEETS_CLIENT_ID',
      type: 'string',
      required: true,
      description: 'Google OAuth client ID for Sheets API',
    },
    GOOGLE_SHEETS_CLIENT_SECRET: {
      key: 'GOOGLE_SHEETS_CLIENT_SECRET',
      type: 'secret',
      required: true,
      description: 'Google OAuth client secret for Sheets API',
    },
    GOOGLE_SHEETS_REDIRECT_URI: {
      key: 'GOOGLE_SHEETS_REDIRECT_URI',
      type: 'string',
      required: false,
      description: 'OAuth redirect URI (defaults to app callback)',
    },
  },

  onInstall: async () => {
    console.log('[google-sheets] Module installed');
  },

  onEnable: async () => {
    console.log('[google-sheets] Module enabled');
  },

  onDisable: async () => {
    console.log('[google-sheets] Module disabled');
  },
};

export default googleSheetsModule;
