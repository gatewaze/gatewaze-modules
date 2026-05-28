-- ============================================================================
-- bulk-emailing 005: template_scope column on email_templates
--
-- Per spec-calendars-microsites §9.5 — Option A:
--   "Add a `template_scope` column ∈ {event, calendar, global}, filter
--    templates by scope in the composer."
--
-- Why bulk-emailing owns this migration (not core gatewaze, not calendars):
--   - email_templates lives in core (gatewaze/supabase/migrations/00005)
--     but bulk-emailing is the module that ships the sending pipeline that
--     consumes them. Adding scope here keeps the modification colocated
--     with the consumers.
--   - Calendars + future content-type modules read filtered templates via
--     `template_scope IN ('<own-scope>', 'global')` — they don't ALTER the
--     table; they just rely on the column being present.
--
-- Default 'event' preserves backwards compatibility — every existing row
-- was authored against the events flow; no editor expects to see them in
-- a non-event composer.
-- ============================================================================

ALTER TABLE public.email_templates
  ADD COLUMN IF NOT EXISTS template_scope text NOT NULL DEFAULT 'event'
  CHECK (template_scope IN ('event', 'calendar', 'global'));

-- Index for the typical "list templates for scope X" query — covers both
-- the calendars composer (`scope IN ('calendar','global')`) and the events
-- composer (`scope IN ('event','global')`). is_active filter is included
-- because every consumer call site will already be filtering inactive out.
CREATE INDEX IF NOT EXISTS idx_email_templates_scope_active
  ON public.email_templates (template_scope, is_active)
  WHERE is_active = true;

COMMENT ON COLUMN public.email_templates.template_scope IS
  'Scope this template can be selected from. Composers filter to their own scope plus ''global''. Per spec-calendars-microsites §9.5 — defaults to ''event'' for backwards compat.';
