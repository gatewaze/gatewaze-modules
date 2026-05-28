import type { GatewazeModule } from '@gatewaze/shared';

const whatsappModule: GatewazeModule = {
  id: 'whatsapp',
  group: 'communications',
  type: 'feature',
  visibility: 'public',
  name: 'WhatsApp Messaging',
  description: 'Send WhatsApp messages via Twilio for event invites and notifications',
  version: '1.0.0',
  features: ['whatsapp', 'whatsapp.send'],
  dependencies: [],
  edgeFunctions: ['whatsapp-send'],
  migrations: ['migrations/001_whatsapp_tables.sql'],
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
    WHATSAPP_FROM_NUMBER: {
      key: 'WHATSAPP_FROM_NUMBER',
      type: 'string',
      required: true,
      description: 'Twilio WhatsApp sender number (E.164, e.g., +14155238886)',
    },
  },
  onInstall: async () => console.log('[whatsapp] Module installed'),
  onEnable: async () => console.log('[whatsapp] Module enabled'),
  onDisable: async () => console.log('[whatsapp] Module disabled'),
};

export default whatsappModule;
