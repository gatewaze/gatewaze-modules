-- Drop the trigger that forbids page_blocks for theme_kind='website' sites.
--
-- Background: migration 006 introduced a strict split between website-kind
-- sites (schema-mode pages, content in `pages.content` JSONB) and email-kind
-- newsletters (blocks-mode, content in `page_blocks`). The canvas / Puck
-- work in migrations 032-036 brought blocks-mode editing to website sites,
-- but the trigger from 006 was never updated. It now blocks legitimate
-- writes from the Puck editor + the aaif-import seed applier.
--
-- The pages.composition_mode column ('schema' | 'blocks') is the
-- authoritative discriminator for content location — the theme_kind no
-- longer constrains content shape.
--
-- Per the AAIF migration + Puck unification direction (spec-aaif-theme-
-- deliverable §5.2 + spec-builder-evaluation §3.6): website sites use Puck
-- for blocks-mode pages; schema-mode pages remain valid for content that
-- doesn't need per-block editing.

DROP TRIGGER IF EXISTS page_blocks_only_for_html_pages ON public.page_blocks;
DROP FUNCTION IF EXISTS public.page_blocks_only_for_html_pages();
