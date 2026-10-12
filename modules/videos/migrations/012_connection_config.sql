-- ============================================================================
-- Module: videos
-- Migration: 012_connection_config
-- Description: Non-secret per-connection settings, and the podcast provider
--              a Spotify-hosted show needs.
-- ============================================================================
--
-- A connection needs settings that are NOT credentials: which RSS feed an
-- episode catalogue comes from, which OP3 show uuid its downloads are under.
-- Putting those in encrypted_credentials would mean decrypting to read a URL
-- and would hide them from anyone debugging a collection. Putting them in
-- separate columns would mean a migration per platform.

SET statement_timeout = '300s';

ALTER TABLE public.video_platform_connections
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.video_platform_connections.config IS
  'Non-secret per-connection settings, readable by anyone who can read the connection. Spotify: {feed_url, op3_show_uuid}. NEVER a token — those go in encrypted_credentials, sealed.';

-- A guard rather than a convention. The whole point of the split is that
-- this column is readable, so a token landing here would be a credential in
-- the clear, and a comment would not stop it.
ALTER TABLE public.video_platform_connections
  DROP CONSTRAINT IF EXISTS video_platform_connections_config_no_secrets;
ALTER TABLE public.video_platform_connections
  ADD CONSTRAINT video_platform_connections_config_no_secrets
  CHECK (
    NOT (config ?| ARRAY['token','secret','password','refresh_token','access_token','client_secret','sp_dc','sp_key','api_key'])
  );
