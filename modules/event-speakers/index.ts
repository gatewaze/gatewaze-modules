import type { GatewazeModule } from '@gatewaze/shared';

const eventSpeakersModule: GatewazeModule = {
  id: 'event-speakers',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Speakers',
  description: 'Speaker profiles, talk submissions, and cross-event speaker management',
  // v2.0.0 — adds calendar / platform scope for talks, canonical person link,
  // top-level Speakers admin nav, calendar submit-talk portal page.
  version: '2.0.0',
  features: [
    'event-speakers',
    'event-speakers.manage',
    'event-speakers.calendar-pool',
    'event-speakers.platform-rollup',
  ],

  migrations: [
    'migrations/001_event_speakers_tables.sql',
    'migrations/002_speakers_rollup.sql',
    'migrations/003_speakers_merge_dedupe.sql',
    'migrations/004_speaker_id_nullable.sql',
    'migrations/005_triage_adapter.sql',
    'migrations/006_register_with_platform.sql',
    'migrations/007_talk_edit_token_default.sql',
    // 008 recreates events_talks_with_speakers per the actual FK:
    // events_talk_speakers.speaker_id → events_speaker_profiles(id). The
    // 004 view joined the bridge against events_speakers.id, which the FK
    // makes impossible to store, so `speakers` was always [] and the admin
    // showed every CFP submission as "Unknown Speaker".
    'migrations/008_fix_talks_with_speakers_view.sql',
    // 009 lets CFP submitters upload their photo: INSERT policy for
    // media/speaker-submissions/ (anon + authenticated). Without it the
    // form's upload silently failed RLS and speakers had no avatar.
    'migrations/009_speaker_submission_uploads.sql',
  ],

  edgeFunctions: [
    'events-speaker-confirm',
    'events-speaker-submission',
    'events-speaker-submissions',
    'events-speaker-tracking-link',
    'events-speaker-update',
    'events-speaker-update-notify',
    'speakers-public-api',
  ],

  adminRoutes: [
    // Speaker + talk detail views remain at /speakers/* so internal links
    // from the speakers list (now rendered as a tab on the Events dashboard)
    // continue to work without rewriting hrefs.
    {
      path: 'speakers/talks',
      component: () => import('./admin/pages/talks-index'),
      requiredFeature: 'event-speakers.platform-rollup',
      guard: 'none',
    },
    {
      path: 'speakers/:id',
      component: () => import('./admin/pages/speaker-detail'),
      requiredFeature: 'event-speakers.platform-rollup',
      guard: 'none',
    },
  ],

  // No top-level "Speakers" nav item — surfaced as a tab on /events
  // (events:tab slot below).
  adminNavItems: [],

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/EventSpeakersTab'),
      order: 20,
      requiredFeature: 'event-speakers',
      meta: { tabId: 'speakers', label: 'Speakers', icon: 'MicrophoneIcon' },
    },
    // Contribute "Speakers" as a tab on the Events dashboard, alongside Hosts.
    {
      slotName: 'events:tab',
      component: () => import('./admin/pages/speakers-index'),
      order: 20,
      requiredFeature: 'event-speakers.platform-rollup',
      meta: { tabId: 'speakers', label: 'Speakers', icon: 'MicrophoneIcon' },
    },
  ],

  dependencies: ['content-platform', 'events', 'event-sponsors'],

  configSchema: {},

  onInstall: async () => {
    console.log('[event-speakers] Module installed');
  },

  onEnable: async () => {
    console.log('[event-speakers] Module enabled');
  },

  onDisable: async () => {
    console.log('[event-speakers] Module disabled');
  },
};

export default eventSpeakersModule;
