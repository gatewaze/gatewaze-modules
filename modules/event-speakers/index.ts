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
  // v2.1.0 — speaker promo kits: auto-generated umami tracking link, AI post
  // variants, rendered social cards + zip for confirmed talks (see guide.md).
  version: '2.1.0',
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
    // 010 additively exposes primary_talk_status + primary_talk_submitted_at on
    // events_speakers_with_details (from the speaker's primary talk via the
    // events_talk_speakers bridge). The review lifecycle lives on events_talks;
    // the view's `status` is participation (used by the public portal) and stays
    // untouched. Event Comms "Send to Existing <status> Speakers" filters the new
    // talk columns so recipients resolve by talk lifecycle, not participation.
    'migrations/010_speakers_view_primary_talk_status.sql',
    // 012 adds the per-speaker event rollup the Speakers directory sorts and
    // filters on: idx_events_speakers_speaker (the junction's only index leads
    // with event_uuid, so aggregating per speaker seq-scanned it) plus the
    // security_invoker view events_speaker_profiles_with_counts, exposing
    // event_count + event_uuids. Granted to authenticated/service_role only —
    // anon would otherwise learn unlisted/draft events exist from the count.
    'migrations/012_speakers_event_count.sql',
    // 013 adds speaker_promo_kits: the per-talk promo bundle (umami tracking
    // link, AI post variants, rendered social cards, zip) generated for
    // confirmed talks by the promo-kit workers. Service-role only; the
    // portal reads kits through an edit_token-authenticated server route.
    'migrations/013_speaker_promo_kits.sql',
    // 014 seeds + binds the speaker-promo-posts AI use-case to its recipe in
    // gatewaze/lf-agents (skipped when the ai module is absent — kits then
    // ship cards + link without text).
    'migrations/014_seed_promo_posts_use_case.sql',
    // 015 admin surfacing: active admins read/update kits (Speakers-tab
    // modal + Regenerate) and manage speaker_promo_event_config, the
    // per-event template-repo/brand mapping override.
    'migrations/015_promo_kit_admin_access.sql',
    // 016 storage INSERT policy for media/talks/* — presentation uploads
    // from the speaker checklist failed RLS on fresh installs (only
    // speaker-submissions/ was covered by 009).
    'migrations/016_talk_presentation_uploads.sql',
    // 017 confirmed_email_sent_at — the speaker-confirmed email sends from
    // the promo-kit worker post-build (zip attached), idempotently.
    'migrations/017_promo_kit_confirmed_email.sql',
    // 018 deck_storage_path — personalized PPTX talk template (branded
    // title slide from the landscape card, talk/speaker pre-filled).
    'migrations/018_promo_kit_slide_deck.sql',
    // 019 declares the five events_talks columns the speaker checklist +
    // confirm flow always used but no migration ever created (confirm links
    // showed 'Invalid Link' because selecting confirmed_at 400ed).
    'migrations/019_talk_checklist_columns.sql',
    // 020 exposes presentation_storage_path/type on events_talks_with_speakers.
    // A speaker who UPLOADS a file sets only the storage path, so the admin
    // progress tick (url || storage_path) never fired for file uploads —
    // the column simply wasn't on the view the admin reads.
    'migrations/020_talks_view_presentation_fields.sql',
    // 021 scheduled "we still need your presentation" reminders: comms
    // settings (enabled/copy/offsets, default 14 + 8 days before) plus a
    // per-(talk, offset) send log that keeps the sweep idempotent.
    'migrations/021_presentation_reminders.sql',
    // 022 + 023 make the talk-edit status reset lenient: the reset still
    // happens immediately (fail-safe), then a worker judges via the ai module
    // whether the edit changed the SUBSTANCE of the talk and restores the
    // previous status when it didn't. 023 is skipped when ai is absent.
    'migrations/022_talk_edit_reviews.sql',
    'migrations/023_talk_edit_materiality_use_case.sql',
  ],

  workers: [
    {
      // File stem MUST equal the job-name suffix: the prod worker derives the
      // job name from the handler filename as `${moduleId}:${stem}`.
      name: 'event-speakers:promo-kit-sweep',
      handler: './workers/promo-kit-sweep.ts',
    },
    {
      name: 'event-speakers:generate-promo-kit',
      handler: './workers/generate-promo-kit.ts',
    },
    {
      name: 'event-speakers:presentation-reminder-sweep',
      handler: './workers/presentation-reminder-sweep.ts',
    },
    {
      name: 'event-speakers:talk-edit-review-sweep',
      handler: './workers/talk-edit-review-sweep.ts',
    },
  ],

  crons: [
    {
      // Heartbeat for speaker promo kits: creates kit rows for newly
      // confirmed talks (upcoming events), retries bounded failures, and
      // advances requested/generating kits. Idempotent; 2-minute cadence
      // keeps "confirm → kit ready" latency low without meaningful load.
      name: 'event-speakers-promo-kit-sweep',
      queue: 'jobs',
      schedule: { pattern: '*/2 * * * *' },
      data: { kind: 'event-speakers:promo-kit-sweep' },
    },
    {
      // Daily nudge for confirmed speakers who still owe us a presentation.
      // Daily (not hourly) because the offsets are whole days and each
      // (talk, offset) can only send once; 09:00 UTC keeps it inside working
      // hours for EU/US-east without needing per-recipient timezone logic.
      name: 'event-speakers-presentation-reminder-sweep',
      queue: 'jobs',
      schedule: { pattern: '0 9 * * *' },
      data: { kind: 'event-speakers:presentation-reminder-sweep' },
    },
    {
      // Judges speaker talk edits soon after they happen. Every 2 minutes so a
      // speaker fixing a typo gets their confirmed status back while they're
      // still on the page, rather than discovering it days later.
      name: 'event-speakers-talk-edit-review-sweep',
      queue: 'jobs',
      schedule: { pattern: '*/2 * * * *' },
      data: { kind: 'event-speakers:talk-edit-review-sweep' },
    },
  ],

  edgeFunctions: [
    // Add-to-calendar links for the speaker checklist (google/outlook/ics),
    // ported from legacy gatewaze-admin — the portal was 404ing without it.
    'calendar',
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

  configSchema: {
    SPEAKER_CARDS_TEMPLATE_REPO: {
      key: 'SPEAKER_CARDS_TEMPLATE_REPO',
      type: 'string',
      required: false,
      description:
        'Git repo holding the speaker promo-card templates, brand colorways, and ' +
        'event→brand mapping (https://github.com/<org>/<repo>[#ref], e.g. ' +
        'https://github.com/gatewaze/gatewaze-template-speaker-cards#main). ' +
        'GitHub only; private repos use the worker\'s GITHUB_TOKEN. Unset = the ' +
        'templates vendored with the module, default Voice colorway for every event.',
    },
  },

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
