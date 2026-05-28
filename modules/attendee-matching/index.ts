import type { GatewazeModule } from '@gatewaze/shared';

const attendeeMatchingModule: GatewazeModule = {
  id: 'attendee-matching',
  group: 'events',
  type: 'feature',
  visibility: 'premium',
  name: 'Attendee Matching',
  description: 'AI-powered 1:1 attendee matching for pre-event networking introductions',
  version: '1.0.0',
  features: [
    'attendee-matching',
    'attendee-matching.generate',
    'attendee-matching.emails',
  ],
  dependencies: ['events'],

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/components/EventMatchingTab'),
      order: 50,
      requiredFeature: 'attendee-matching',
      meta: { label: 'Matching', icon: 'UserGroupIcon' },
    },
  ],

  edgeFunctions: [
    'events-generate-matches',
    'events-send-match-emails',
  ],

  migrations: [
    'migrations/001_attendee_matching.sql',
  ],

  configSchema: {
    ANTHROPIC_API_KEY: {
      key: 'ANTHROPIC_API_KEY',
      type: 'secret',
      required: true,
      description: 'Anthropic API key for AI-powered match generation',
    },
    SENDGRID_API_KEY: {
      key: 'SENDGRID_API_KEY',
      type: 'secret',
      required: true,
      description: 'SendGrid API key for sending introduction emails',
    },
    MATCH_EMAIL_FROM_ADDRESS: {
      key: 'MATCH_EMAIL_FROM_ADDRESS',
      type: 'string',
      required: false,
      description: 'Default from address for match intro emails (e.g. events@example.com)',
    },
  },

  onInstall: async () => {
    console.log('[attendee-matching] Module installed');
  },

  onEnable: async () => {
    console.log('[attendee-matching] Module enabled');
  },

  onDisable: async () => {
    console.log('[attendee-matching] Module disabled');
  },
};

export default attendeeMatchingModule;
