-- Partial index for the guest gallery / projector display polling query
-- (event-media guest uploads): host_id equality + (created_at, id)
-- keyset, filtered to publicly visible rows. The display page polls
-- every ~10 s, so this must never seq-scan.
--
-- Owned by host-media (its table); requested by
-- spec-event-media-guest-uploads §4.

CREATE INDEX IF NOT EXISTS idx_host_media_event_public_feed
  ON public.host_media (host_id, created_at DESC, id DESC)
  WHERE host_kind = 'event'
    AND access_level = 'public'
    AND is_approved = true;
