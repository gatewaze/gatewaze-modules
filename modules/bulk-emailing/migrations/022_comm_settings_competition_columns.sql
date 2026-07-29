-- ============================================================================
-- bulk-emailing 022: competition_* email columns on events_communication_settings
--
-- The event Comms settings form (EventCommunicationsTab, this module) saves the
-- WHOLE settings object in one .update(settingsData) — including a block of
-- competition_* email fields (entry / non_winner / winner / winner_accepted /
-- winner_followup) — regardless of whether the competitions module is installed.
-- But no migration in ANY module ever created those columns: bulk-emailing 003
-- and competitions 001 both `CREATE TABLE IF NOT EXISTS events_communication_
-- settings`, and whichever ran first wins — the second no-ops and never adds the
-- other's columns. On prod the table came up without the competition_* set, so
-- saving comms settings throws PGRST204 ("could not find the
-- 'competition_entry_email_cc' column") — blocking the save for EVERY email type
-- (speaker approved included), since it's one all-fields update.
--
-- Owned here (not competitions) because the columns must exist wherever this
-- shared form runs, competitions installed or not. Additive + idempotent.
-- Exactly the 24 columns settingsData writes (winner/accepted/followup carry a
-- reduced field set, matching the form).
-- ============================================================================

-- competition_entry (full set)
ALTER TABLE public.events_communication_settings
  ADD COLUMN IF NOT EXISTS competition_entry_email_enabled     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS competition_entry_email_template_id uuid,
  ADD COLUMN IF NOT EXISTS competition_entry_email_from_key    text,
  ADD COLUMN IF NOT EXISTS competition_entry_email_reply_to    text,
  ADD COLUMN IF NOT EXISTS competition_entry_email_cc          text,
  ADD COLUMN IF NOT EXISTS competition_entry_email_subject     text,
  ADD COLUMN IF NOT EXISTS competition_entry_email_content     text;

-- competition_non_winner (full set)
ALTER TABLE public.events_communication_settings
  ADD COLUMN IF NOT EXISTS competition_non_winner_email_enabled     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS competition_non_winner_email_template_id uuid,
  ADD COLUMN IF NOT EXISTS competition_non_winner_email_from_key    text,
  ADD COLUMN IF NOT EXISTS competition_non_winner_email_reply_to    text,
  ADD COLUMN IF NOT EXISTS competition_non_winner_email_cc          text,
  ADD COLUMN IF NOT EXISTS competition_non_winner_email_subject     text,
  ADD COLUMN IF NOT EXISTS competition_non_winner_email_content     text;

-- competition_winner (no _enabled / _cc, per the form)
ALTER TABLE public.events_communication_settings
  ADD COLUMN IF NOT EXISTS competition_winner_email_template_id uuid,
  ADD COLUMN IF NOT EXISTS competition_winner_email_from_key    text,
  ADD COLUMN IF NOT EXISTS competition_winner_email_reply_to    text,
  ADD COLUMN IF NOT EXISTS competition_winner_email_subject     text,
  ADD COLUMN IF NOT EXISTS competition_winner_email_content     text;

-- competition_winner_accepted (template_id / subject / content)
ALTER TABLE public.events_communication_settings
  ADD COLUMN IF NOT EXISTS competition_winner_accepted_email_template_id uuid,
  ADD COLUMN IF NOT EXISTS competition_winner_accepted_email_subject     text,
  ADD COLUMN IF NOT EXISTS competition_winner_accepted_email_content     text;

-- competition_winner_followup (template_id / content)
ALTER TABLE public.events_communication_settings
  ADD COLUMN IF NOT EXISTS competition_winner_followup_email_template_id uuid,
  ADD COLUMN IF NOT EXISTS competition_winner_followup_email_content     text;
