-- Cvent Real-Time Contact Sync Trigger
-- Fires when customer attributes change (first_name, last_name, job_title, company)
-- and the customer is registered for a Cvent-enabled event.
-- Calls the cvent-sync edge function to update the contact in Cvent.
--
-- This enables badge printing at events to reflect real-time data changes.
--
-- Prerequisites:
-- 1. pg_net extension must be enabled (it is by default on Supabase)
-- 2. The cvent-sync edge function must be deployed
-- 3. Vault secrets must be configured:
--    SELECT vault.create_secret('https://your-supabase-url', 'supabase_url', 'Supabase URL');
--    SELECT vault.create_secret('YOUR_SERVICE_ROLE_KEY', 'service_role_key', 'Service role key');

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Create the trigger function
CREATE OR REPLACE FUNCTION sync_customer_to_cvent()
RETURNS TRIGGER AS $$
DECLARE
  function_url TEXT;
  service_key TEXT;
  request_id BIGINT;
  old_attrs JSONB;
  new_attrs JSONB;
  has_cvent_registration BOOLEAN;
BEGIN
  -- Only fire on UPDATE with changed attributes
  IF TG_OP != 'UPDATE' THEN
    RETURN NEW;
  END IF;

  -- Skip if attributes haven't changed
  IF OLD.attributes IS NOT DISTINCT FROM NEW.attributes THEN
    RETURN NEW;
  END IF;

  -- Skip if no email
  IF NEW.email IS NULL OR NEW.email = '' THEN
    RETURN NEW;
  END IF;

  -- Check if the relevant badge fields actually changed
  old_attrs := COALESCE(OLD.attributes, '{}'::jsonb);
  new_attrs := COALESCE(NEW.attributes, '{}'::jsonb);

  IF (old_attrs->>'first_name') IS NOT DISTINCT FROM (new_attrs->>'first_name')
     AND (old_attrs->>'last_name') IS NOT DISTINCT FROM (new_attrs->>'last_name')
     AND (old_attrs->>'job_title') IS NOT DISTINCT FROM (new_attrs->>'job_title')
     AND (old_attrs->>'company') IS NOT DISTINCT FROM (new_attrs->>'company') THEN
    -- None of the Cvent-relevant fields changed, skip
    RETURN NEW;
  END IF;

  -- Check if this customer has registrations for any Cvent-enabled event
  SELECT EXISTS (
    SELECT 1
    FROM event_registrations er
    JOIN member_profiles mp ON mp.id = er.member_profile_id
    JOIN events e ON e.event_id = er.event_id
    WHERE mp.customer_id = NEW.id
      AND e.cvent_sync_enabled = true
      AND e.cvent_event_id IS NOT NULL
      AND er.status IN ('confirmed', 'pending', 'waitlist')
    LIMIT 1
  ) INTO has_cvent_registration;

  IF NOT has_cvent_registration THEN
    RETURN NEW;
  END IF;

  -- Get service role key from vault
  BEGIN
    SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'sync_customer_to_cvent: Could not retrieve service role key: %', SQLERRM;
    RETURN NEW;
  END;

  IF service_key IS NULL THEN
    RAISE LOG 'sync_customer_to_cvent: Service role key not found in vault';
    RETURN NEW;
  END IF;

  -- Get the function URL
  BEGIN
    function_url := get_supabase_function_url('cvent-sync');
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'sync_customer_to_cvent: Could not get function URL: %', SQLERRM;
    RETURN NEW;
  END;

  -- Make async HTTP request to edge function using pg_net
  BEGIN
    SELECT net.http_post(
      url := function_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || service_key
      ),
      body := jsonb_build_object(
        'action', 'update-contact',
        'customer_id', NEW.id
      )
    ) INTO request_id;

    RAISE LOG 'sync_customer_to_cvent: Triggered sync for customer % (email: %, request_id: %)',
      NEW.id, NEW.email, request_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'sync_customer_to_cvent: Failed to trigger sync for customer %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create the trigger
DROP TRIGGER IF EXISTS trigger_sync_customer_to_cvent ON customers;
CREATE TRIGGER trigger_sync_customer_to_cvent
  AFTER UPDATE OF attributes ON customers
  FOR EACH ROW
  EXECUTE FUNCTION sync_customer_to_cvent();

-- Grant execute permission
GRANT EXECUTE ON FUNCTION sync_customer_to_cvent() TO postgres;

COMMENT ON FUNCTION sync_customer_to_cvent() IS
'Real-time sync of customer attribute changes to Cvent for badge printing.
Only fires when first_name, last_name, job_title, or company change,
and the customer is registered for a Cvent-enabled event.';
