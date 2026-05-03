-- Add api_key field to lists for external system authentication.
-- External systems use this key to subscribe/unsubscribe via the public webhook endpoints.

ALTER TABLE public.lists ADD COLUMN IF NOT EXISTS api_key text;

-- Generate a default API key for existing lists
UPDATE public.lists
SET api_key = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
WHERE api_key IS NULL;
