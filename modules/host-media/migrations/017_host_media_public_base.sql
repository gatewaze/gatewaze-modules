-- The public address of a storage provider's bucket, for pages that build
-- photo addresses from host_media rows without the storage module.
--
-- The portal reads host_media with the anon key and cannot read
-- installed_modules. This returns only the provider's public base URL (the
-- `<PROVIDER>_PUBLIC_URL` setting of the enabled `storage-<provider>` module,
-- e.g. R2_PUBLIC_URL), and only when the bucket asked for is the one that
-- module serves. Nothing secret is reachable through it.
--
-- NULL means "no public address here": Supabase rows (callers build those
-- themselves), an unknown or disabled provider, or another bucket.

CREATE OR REPLACE FUNCTION public.host_media_public_base(p_provider text, p_bucket text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT rtrim(m.config ->> (upper(p_provider) || '_PUBLIC_URL'), '/')
    FROM public.installed_modules m
   WHERE p_provider ~ '^[a-z0-9][a-z0-9-]{0,30}$'
     AND p_provider <> 'supabase'
     AND m.id = 'storage-' || p_provider
     AND m.status = 'enabled'
     AND m.config ->> (upper(p_provider) || '_BUCKET') = p_bucket
     AND m.config ->> (upper(p_provider) || '_PUBLIC_URL') ~ '^https://[A-Za-z0-9.-]+/?$'
$$;

REVOKE ALL ON FUNCTION public.host_media_public_base(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.host_media_public_base(text, text) TO anon, authenticated, service_role;
