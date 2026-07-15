-- ============================================================================
-- scrapers module — seed the Luma Signup Events scraper
--
-- Reverse signup flow: when Luma signup notification emails arrive for an
-- event Gatewaze doesn't have yet, the luma module queues them as
-- integrations_luma_pending_registrations rows with status 'no_event'.
-- This scheduled scraper (LumaPendingEventsScraper) scrapes those events'
-- public pages, creates them as Community-categorised events held in
-- pending_review (so they surface in the Content Inbox, never auto-publish),
-- and replays the queued registrations once the event exists.
--
-- Harmless no-op on brands without the luma module: the scraper exits
-- cleanly when the pending registrations table is absent.
-- ============================================================================

INSERT INTO scrapers (
  name, description, scraper_type, object_type, event_type,
  content_category, default_publish_state, base_url, enabled,
  timeout_minutes, alert_on_failure, config,
  schedule_enabled, schedule_frequency
)
SELECT
  'Luma Signup Events',
  'Auto-creates events from queued Luma signup notification emails (reverse signup flow). New events land in the Content Inbox as pending_review / community; queued signups are attached as registrations once the event exists.',
  'LumaPendingEventsScraper', 'events', 'mixed',
  'community', 'pending_review', NULL, true,
  15, true, '{"maxEventsPerRun": 20}',
  true, 'hourly'
WHERE NOT EXISTS (
  SELECT 1 FROM scrapers WHERE scraper_type = 'LumaPendingEventsScraper'
);
