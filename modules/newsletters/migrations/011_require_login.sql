-- Add require_login flag to newsletters.
-- When true, only authenticated subscribers can view editions on the portal.

ALTER TABLE public.newsletters_template_collections
  ADD COLUMN IF NOT EXISTS require_login boolean DEFAULT false;
