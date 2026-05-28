import type { GatewazeModule } from '@gatewaze/shared';

const twilioSmsModule: GatewazeModule = {
  id: 'twilio-sms',
  group: 'communications',
  type: 'feature',
  visibility: 'public',
  name: 'Twilio SMS',
  description: 'Send SMS messages via Twilio for event invites and notifications',
  version: '1.0.0',
  features: ['twilio-sms', 'twilio-sms.send'],
  dependencies: [],
  edgeFunctions: ['sms-send'],
  migrations: ['migrations/001_sms_tables.sql'],
  configSchema: {
    TWILIO_ACCOUNT_SID: {
      key: 'TWILIO_ACCOUNT_SID',
      type: 'string',
      required: true,
      description: 'Twilio Account SID',
    },
    TWILIO_AUTH_TOKEN: {
      key: 'TWILIO_AUTH_TOKEN',
      type: 'string',
      required: true,
      description: 'Twilio Auth Token',
    },
    TWILIO_PHONE_NUMBER: {
      key: 'TWILIO_PHONE_NUMBER',
      type: 'string',
      required: true,
      description: 'Twilio sender phone number (E.164 format)',
    },
  },
  onInstall: async () => console.log('[twilio-sms] Module installed'),
  onEnable: async () => console.log('[twilio-sms] Module enabled'),
  onDisable: async () => console.log('[twilio-sms] Module disabled'),
};

export default twilioSmsModule;
