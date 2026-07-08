-- ============================================================================
-- Module: newsletters
-- Migration: 067_event_block_defs
-- Description: Seed the `local_events` and `virtual_events` block-defs into
-- every email library (templates_libraries where theme_kind='email'), so they
-- appear in the Puck drawer — including git-driven newsletters (e.g. the MLOps
-- community newsletter), whose block library is otherwise fully controlled by
-- its git repo.
--
-- These are react-email blocks (render_kind='react-email'), NOT declarative:
-- their content is resolved per-recipient / per-send at send time and can't be
-- expressed as a static declarative template. The React components live in
-- modules/newsletters/admin/components/puck/email-blocks/blocks/LocalEvents.tsx
-- and VirtualEvents.tsx (componentId 'local_events' / 'virtual_events'); the
-- send-engine binding resolves their {{...}} tokens via
-- workers/event-personalisation.ts. buildEmailRegistry() surfaces the
-- react-email Component alongside the git-authored declarative blocks (see the
-- addReactEmail() merge in declarative/registry.ts).
--
-- html='' is intentional — the Component (not an html template) renders these.
-- The render_kind/component_id CHECK requires a non-empty component_id.
--
-- Idempotent — guarded by NOT EXISTS on (library_id, component_id, is_current)
-- and the UNIQUE (library_id, key, version) constraint.
-- ============================================================================

INSERT INTO public.templates_block_defs (
  library_id, key, name, description, source_kind,
  schema, html, version, is_current, theme_kind, block_kind,
  audience, render_kind, component_id
)
SELECT
  lib.id,
  v.key,
  v.name,
  v.description,
  'static',
  v.schema,
  '',
  1,
  true,
  'email',
  'static',
  'public',
  'react-email',
  v.key
FROM public.templates_libraries lib
CROSS JOIN (VALUES
  (
    'local_events',
    'Local Events (near reader)',
    'Per-recipient list of upcoming in-person events near the reader, resolved at send time. Readers with no nearby events don''t see this block.',
    '{"heading":{"type":"text","label":"Heading"},"intro":{"type":"textarea","label":"Intro text (optional)"},"max_events":{"type":"number","label":"Max events to show"},"radius_miles":{"type":"number","label":"Radius (miles)"}}'::jsonb
  ),
  (
    'virtual_events',
    'Virtual Events',
    'List of upcoming virtual/online events, resolved at send time. Omitted when there are none.',
    '{"heading":{"type":"text","label":"Heading"},"intro":{"type":"textarea","label":"Intro text (optional)"},"max_events":{"type":"number","label":"Max events to show"}}'::jsonb
  )
) AS v(key, name, description, schema)
WHERE lib.theme_kind = 'email'
  AND NOT EXISTS (
    SELECT 1 FROM public.templates_block_defs ex
    WHERE ex.library_id = lib.id
      AND ex.component_id = v.key
      AND ex.is_current = true
  );
