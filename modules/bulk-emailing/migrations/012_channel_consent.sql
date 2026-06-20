-- ============================================================================
-- Module: bulk-emailing
-- Migration: 012_channel_consent
-- Description: Central Sending Service channel abstraction (Phase 4). Per-
-- (person, channel, topic) consent/opt-out, generalising the email "topic"
-- unsubscribe model to "(channel, topic)" (spec-central-sending-service.md
-- §Channel abstraction). Additive + inert: the channel-aware fanout consent
-- check is a follow-on; this ships the table + the quota key already keys on
-- (brand, channel) (migration 010).
-- ============================================================================

-- Opt-out is the recorded state (absence = consented, matching the existing
-- email default). A NULL topic is a channel-wide opt-out (all topics).
CREATE TABLE IF NOT EXISTS public.channel_consent (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid,
  address       text,                       -- denormalised email / E.164 phone / handle
  channel       text NOT NULL CHECK (channel IN ('email','sms','whatsapp','in_app')),
  topic         text,                       -- NULL = all topics on this channel
  opted_out     boolean NOT NULL DEFAULT true,
  opted_out_at  timestamptz NOT NULL DEFAULT now(),
  source        text,                       -- e.g. 'one_click', 'preferences', 'sms_stop', 'bounce'
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz
);

-- One opt-out row per (person, channel, topic); NULL topic distinguished via the
-- partial uniques so a channel-wide and a per-topic opt-out can coexist.
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_consent_person_topic
  ON public.channel_consent (person_id, channel, topic) WHERE person_id IS NOT NULL AND topic IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_consent_person_channel
  ON public.channel_consent (person_id, channel) WHERE person_id IS NOT NULL AND topic IS NULL;
CREATE INDEX IF NOT EXISTS idx_channel_consent_address
  ON public.channel_consent (channel, address) WHERE address IS NOT NULL;

COMMENT ON TABLE public.channel_consent IS
  'Per-(person, channel, topic) opt-out for the Central Sending Service. Absence = consented. NULL topic = channel-wide opt-out. Checked channel-aware at fanout (follow-on).';
