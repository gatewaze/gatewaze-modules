-- ============================================================================
-- Migration: sites_004_fks_to_templates
-- Description: Foreign keys that point from sites schema rows to templates
--              module rows. Done in a separate migration so this one can be
--              re-run with NOT VALID + VALIDATE if the templates module is
--              installed AFTER sites in some atypical deployment order.
-- ============================================================================

-- sites.templates_library_id -> templates_libraries.id
ALTER TABLE public.sites
  ADD CONSTRAINT sites_templates_library_id_fkey
  FOREIGN KEY (templates_library_id) REFERENCES public.templates_libraries(id) ON DELETE SET NULL;

-- pages.templates_library_id -> templates_libraries.id
ALTER TABLE public.pages
  ADD CONSTRAINT pages_templates_library_id_fkey
  FOREIGN KEY (templates_library_id) REFERENCES public.templates_libraries(id) ON DELETE RESTRICT;

-- pages.template_def_id -> templates_definitions.id
ALTER TABLE public.pages
  ADD CONSTRAINT pages_template_def_id_fkey
  FOREIGN KEY (template_def_id) REFERENCES public.templates_definitions(id) ON DELETE SET NULL;

-- pages.wrapper_def_id -> templates_wrappers.id
ALTER TABLE public.pages
  ADD CONSTRAINT pages_wrapper_def_id_fkey
  FOREIGN KEY (wrapper_def_id) REFERENCES public.templates_wrappers(id) ON DELETE SET NULL;

-- pages.ab_test_id -> templates_ab_tests.id
ALTER TABLE public.pages
  ADD CONSTRAINT pages_ab_test_id_fkey
  FOREIGN KEY (ab_test_id) REFERENCES public.templates_ab_tests(id) ON DELETE SET NULL;

-- page_blocks.block_def_id -> templates_block_defs.id
ALTER TABLE public.page_blocks
  ADD CONSTRAINT page_blocks_block_def_id_fkey
  FOREIGN KEY (block_def_id) REFERENCES public.templates_block_defs(id) ON DELETE RESTRICT;

-- page_block_bricks.brick_def_id -> templates_brick_defs.id
ALTER TABLE public.page_block_bricks
  ADD CONSTRAINT page_block_bricks_brick_def_id_fkey
  FOREIGN KEY (brick_def_id) REFERENCES public.templates_brick_defs(id) ON DELETE RESTRICT;

-- ON DELETE RESTRICT on block_def / brick_def / templates_library is intentional:
-- the templates module's apply flow soft-archives via is_current=false rather
-- than deleting rows, so an in-use block-def is never hard-deleted while
-- instances reference it. If an admin force-deletes a block-def, the FK
-- prevents leaving page_blocks in an inconsistent state.
