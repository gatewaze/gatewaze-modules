-- Poses: what the booth asks people to do.
--
-- off   the booth just takes the photograph (what it did before)
-- hour  everyone is asked for the same pose for a while, so the
--       projector fills with different takes on it
-- card  the booth deals a pose at random each time someone steps in
--
-- pose_minutes is how long a 'hour' pose lasts; pose_offset puts two
-- events on the same evening out of step. fingers_pick lets the photo
-- choose its own look: hold up one to five fingers.

ALTER TABLE public.events_media_booth_settings
  ADD COLUMN IF NOT EXISTS pose_mode    text    NOT NULL DEFAULT 'off'
    CHECK (pose_mode IN ('off', 'hour', 'card')),
  ADD COLUMN IF NOT EXISTS pose_minutes integer NOT NULL DEFAULT 30
    CHECK (pose_minutes BETWEEN 5 AND 240),
  ADD COLUMN IF NOT EXISTS pose_offset  integer NOT NULL DEFAULT 0
    CHECK (pose_offset BETWEEN 0 AND 999),
  ADD COLUMN IF NOT EXISTS fingers_pick boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.events_media_booth_settings.pose_mode IS
  'off | hour (one pose for everyone, rotating) | card (a random pose each sitting)';
COMMENT ON COLUMN public.events_media_booth_settings.fingers_pick IS
  'Offer the guest the five looks of their decade by holding up fingers in the photo.';
