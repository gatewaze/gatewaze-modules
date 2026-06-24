-- ============================================================================
-- Module: newsletters
-- Migration: 058_email_only_intro_block_def
-- Description: Seed a new `email_only_intro` block-def into every email
-- library (templates_libraries where theme_kind='email'), as a copy of the
-- existing `intro_paragraph` block-def for that library when one exists, and
-- as a fresh default row for libraries that don't have intro_paragraph.
--
-- The new block renders identically to IntroParagraph in the sent email but
-- the portal /View Online/ page filters any block whose `block_type` starts
-- with `email_only_` (see modules/newsletters/portal/pages/[collection]/
-- [edition].tsx — paired with this migration in the same release). The
-- canonical use case is the apology header on a re-send where the public
-- archive shouldn't carry the apology.
--
-- The React component is registered in
-- modules/newsletters/admin/components/puck/email-blocks/blocks/EmailOnlyIntro.tsx
-- with componentId = 'email_only_intro'. This migration's templates_block_defs
-- rows are what surfaces the block in the Puck drawer for each library.
--
-- Idempotent — the UNIQUE (library_id, key, version) constraint guarantees
-- safe re-runs.
-- ============================================================================

-- 1. Copy intro_paragraph -> email_only_intro for every email library that
-- has an intro_paragraph row. Reuses html / rich_text_template / schema so
-- the rendered output matches one-for-one.
INSERT INTO public.templates_block_defs (
  library_id, key, name, description, source_kind,
  schema, html, rich_text_template, has_bricks, data_source,
  version, is_current, theme_kind, block_kind, kind_config_schema,
  audience, freshness, component_export_path, source_format,
  requires_consent, render_kind, component_id
)
SELECT
  ip.library_id,
  'email_only_intro'                                              AS key,
  'Email-only Intro (not shown on portal)'                        AS name,
  COALESCE(ip.description, '') ||
    CASE WHEN ip.description IS NOT NULL AND ip.description <> '' THEN E'\n\n' ELSE '' END ||
    'Renders ONLY in the sent email — the public View Online page filters this block out. Use for apology headers and other inbox-only content.'
                                                                  AS description,
  ip.source_kind,
  ip.schema,
  ip.html,
  ip.rich_text_template,
  ip.has_bricks,
  ip.data_source,
  1                                                               AS version,
  true                                                            AS is_current,
  ip.theme_kind,
  ip.block_kind,
  ip.kind_config_schema,
  ip.audience,
  ip.freshness,
  ip.component_export_path,
  ip.source_format,
  ip.requires_consent,
  ip.render_kind,
  'email_only_intro'                                              AS component_id
FROM public.templates_block_defs ip
JOIN public.templates_libraries lib ON lib.id = ip.library_id
WHERE ip.component_id = 'intro_paragraph'
  AND ip.is_current = true
  AND lib.theme_kind = 'email'
  AND NOT EXISTS (
    SELECT 1 FROM public.templates_block_defs ex
    WHERE ex.library_id = ip.library_id
      AND ex.component_id = 'email_only_intro'
      AND ex.is_current = true
  );

-- 2. For email libraries that DON'T have an intro_paragraph row to copy from,
-- seed a fresh email_only_intro with the canonical declarative template (the
-- same source the IntroParagraph block uses in the email-blocks registry).
INSERT INTO public.templates_block_defs (
  library_id, key, name, description, source_kind,
  schema, html, version, is_current, theme_kind, block_kind,
  audience, render_kind, component_id
)
SELECT
  lib.id                                                                  AS library_id,
  'email_only_intro'                                                      AS key,
  'Email-only Intro (not shown on portal)'                                AS name,
  'Renders ONLY in the sent email — the public View Online page filters this block out. Use for apology headers and other inbox-only content.'
                                                                          AS description,
  'static'                                                                AS source_kind,
  '{"text": {"type": "richtext", "label": "Text"}}'::jsonb                AS schema,
  E'<Section class="column">\n  <richtext field="text" style="font-family:Arial,''Helvetica Neue'',Helvetica,sans-serif;font-size:20px;line-height:1.5;color:#555;padding:20px 15px" />\n</Section>'
                                                                          AS html,
  1                                                                       AS version,
  true                                                                    AS is_current,
  'email'                                                                 AS theme_kind,
  'static'                                                                AS block_kind,
  'public'                                                                AS audience,
  'declarative'                                                           AS render_kind,
  'email_only_intro'                                                      AS component_id
FROM public.templates_libraries lib
WHERE lib.theme_kind = 'email'
  AND NOT EXISTS (
    SELECT 1 FROM public.templates_block_defs ex
    WHERE ex.library_id = lib.id
      AND ex.component_id = 'email_only_intro'
      AND ex.is_current = true
  );

COMMENT ON COLUMN public.templates_block_defs.component_id IS
  'React component id matching email-blocks registry. For email_only_intro the portal /View Online/ page filters the block out at render time (see [collection]/[edition].tsx — the filter is on `block_type` starting with `email_only_` so any future email-only block is included automatically).';
