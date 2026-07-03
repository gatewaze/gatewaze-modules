-- events_talks.edit_token: mint on insert + backfill NULLs.
--
-- The CFP submission flow inserts a talk without a token and immediately
-- selects it back (`.insert(talkData).select('id, edit_token')`), expecting the
-- DATABASE to generate it — but the column never had a default, so every talk
-- got NULL. Per-talk edit links then degraded to token-less URLs, which can
-- only ever resolve ONE of a speaker's talks (a speaker with several
-- submissions couldn't reach the specific talk they clicked).
--
-- gen_random_uuid() gives 122 bits of entropy; the token is opaque text
-- everywhere it's consumed (edit page lookup + events-speaker-* functions).

ALTER TABLE public.events_talks
  ALTER COLUMN edit_token SET DEFAULT gen_random_uuid()::text;

UPDATE public.events_talks
SET edit_token = gen_random_uuid()::text
WHERE edit_token IS NULL;
