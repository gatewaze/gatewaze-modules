-- ============================================================================
-- Module: engagement
-- Migration: 003_engagement_default_rules
-- Description: Seed the default scoring rules and a handful of starter badges.
--              Idempotent via ON CONFLICT — safe to re-run.
-- ============================================================================

-- ==========================================================================
-- Default scoring rules
-- ==========================================================================
INSERT INTO public.engagement_rules (signal, label, description, default_points, cooldown_seconds, daily_cap, scope)
VALUES
  ('event.registered',          'Event registered',          'Awarded when a member registers for an event', 5,   0,   NULL, 'per_event'),
  ('event.attended',            'Event attended',            'Awarded when a member checks in / attends an event', 20,  0,   NULL, 'per_event'),
  ('event.attended.first_time', 'First event attended',      'Bonus awarded on a member''s first-ever attendance', 25,  0,   NULL, 'global'),
  ('calendar.joined',           'Calendar joined',           'Awarded when a member signs up to a calendar', 10,  0,   NULL, 'per_calendar'),
  ('calendar.confirmed',        'Calendar signup confirmed', 'Bonus when the member confirms via email', 5,   0,   NULL, 'per_calendar'),
  ('media.contributed',         'Media contributed',         'Awarded when a member uploads a photo or video', 5,   0,   NULL, 'per_event'),
  ('talk.submitted',            'Talk submitted',            'Awarded when a speaker submits a talk', 15,  0,   NULL, 'per_event'),
  ('talk.accepted',             'Talk accepted',             'Bonus when a submitted talk is accepted', 50,  0,   NULL, 'per_event'),
  ('talk.delivered',            'Talk delivered',            'Awarded when a speaker successfully delivers their talk', 100, 0,   NULL, 'per_event'),
  ('talk.calendar_offered',     'Talk offered to chapter',   'Awarded for submitting a talk to a specific calendar', 20,  0,   NULL, 'per_calendar'),
  ('conversations.posted',      'Chat message posted',       'Awarded per chat message posted in any channel', 1,   60,  50,   'per_calendar'),
  ('conversations.reaction_received', 'Reaction received', 'Awarded when someone reacts to your message', 1, 0, 100, 'per_calendar'),
  ('profile.completed',         'Profile completed',         'Awarded when a member fills in their profile', 10,  0,   NULL, 'global')
ON CONFLICT (signal) DO NOTHING;

-- ==========================================================================
-- Starter badges
-- ==========================================================================
INSERT INTO public.engagement_badges (slug, label, description, icon, color, rule_kind, rule_config, scope, sort_order)
VALUES
  ('first-attendance', 'First Attendance', 'Attended your first event', 'star', '#FFD700',
    'first', '{"signal":"event.attended"}'::jsonb, 'global', 10),
  ('regular-attendee', '10 Events Attended', 'Attended 10 events on the platform', 'trophy', '#C0C0C0',
    'count', '{"signal":"event.attended","count":10}'::jsonb, 'global', 20),
  ('super-attendee', '50 Events Attended', 'Attended 50 events — you live for this', 'trophy', '#FFD700',
    'count', '{"signal":"event.attended","count":50}'::jsonb, 'global', 30),
  ('speaker', 'Speaker', 'Delivered a talk at an event', 'microphone', '#8B5CF6',
    'first', '{"signal":"talk.delivered"}'::jsonb, 'global', 40),
  ('chapter-founder', 'Chapter Founder', 'Manually awarded to the organisers who built a chapter',
    'flag', '#EF4444', 'manual', '{}'::jsonb, 'per_calendar', 50),
  ('top-contributor', 'Top Contributor', 'Crossed 1000 engagement points', 'fire', '#F59E0B',
    'threshold', '{"min_points":1000}'::jsonb, 'global', 60),
  ('conversationalist', 'Conversationalist', 'Posted 100 chat messages', 'chat-bubble', '#10B981',
    'count', '{"signal":"conversations.posted","count":100}'::jsonb, 'global', 70)
ON CONFLICT (slug) DO NOTHING;
