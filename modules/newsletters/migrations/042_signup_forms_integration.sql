-- 042: Newsletter signup via the forms module.
--
-- Wires the portal newsletter signup (forms module) through to a real subscription, using the
-- newsletter's MANUALLY-linked subscriber list (`newsletters_template_collections.list_id`, set via
-- the admin "Subscription List" selector — the list must be created first, then linked). This module
-- never auto-creates a list.
--
--   1. A single shared `newsletter-signup` form (forms module). On submit the forms endpoint creates
--      the person + auth record (people-signup) before the trigger below runs.
--   2. A trigger on forms_submissions that, for that form, reads the `collection` response, finds the
--      collection's linked `list_id`, and upserts a `list_subscriptions` row. No linked list → no-op.
--
-- Cross-module: the forms + lists tables belong to other modules, so every reference is guarded so
-- this migration applies cleanly even when those modules aren't installed.

-- 1. Shared signup form (forms module) -----------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'forms')
     AND NOT EXISTS (SELECT 1 FROM public.forms WHERE slug = 'newsletter-signup') THEN
    INSERT INTO public.forms (slug, name, description, fields, thank_you_message, is_active, content_category)
    VALUES (
      'newsletter-signup',
      'Newsletter signup',
      'Subscribe to a newsletter.',
      '[{"id":"email","type":"email","label":"Email","placeholder":"you@example.com","required":true}]'::jsonb,
      'Thanks — you are subscribed. Watch your inbox for the next edition.',
      true,
      'newsletter'
    );
  END IF;
END $$;

-- 2. Subscribe on submit — to the collection's manually-linked list ------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'forms_submissions')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'list_subscriptions') THEN

    CREATE OR REPLACE FUNCTION public.newsletters_map_signup_submission()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
    DECLARE
      v_form_slug       text;
      v_collection_slug text;
      v_email           text;
      v_list_id         uuid;
    BEGIN
      SELECT slug INTO v_form_slug FROM public.forms WHERE id = NEW.form_id;
      -- Only act on newsletter signup forms (shared `newsletter-signup` or `newsletter-<x>-signup`).
      IF v_form_slug IS NULL OR v_form_slug NOT LIKE 'newsletter-%signup' THEN
        RETURN NEW;
      END IF;

      v_collection_slug := NEW.responses->>'collection';
      v_email := lower(trim(NEW.responses->>'email'));
      IF v_collection_slug IS NULL OR v_email IS NULL OR v_email = '' THEN
        RETURN NEW;
      END IF;

      -- Subscribe only if the newsletter has a list manually linked. No list → no-op.
      SELECT list_id INTO v_list_id
        FROM public.newsletters_template_collections WHERE slug = v_collection_slug;
      IF v_list_id IS NULL THEN
        RETURN NEW;
      END IF;

      INSERT INTO public.list_subscriptions (list_id, person_id, email, subscribed, subscribed_at, source)
      VALUES (v_list_id, NEW.person_id, v_email, true, now(), 'newsletter-signup')
      ON CONFLICT (list_id, email) DO UPDATE
        SET subscribed = true,
            unsubscribed_at = NULL,
            person_id = COALESCE(list_subscriptions.person_id, EXCLUDED.person_id);
      RETURN NEW;
    END;
    $fn$;

    DROP TRIGGER IF EXISTS trg_newsletters_map_signup ON public.forms_submissions;
    CREATE TRIGGER trg_newsletters_map_signup
      AFTER INSERT ON public.forms_submissions
      FOR EACH ROW EXECUTE FUNCTION public.newsletters_map_signup_submission();
  END IF;
END $$;
