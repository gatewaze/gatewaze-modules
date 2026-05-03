-- Link brick templates to their parent block templates for export/import round-trip fidelity
ALTER TABLE newsletters_brick_templates
  ADD COLUMN IF NOT EXISTS block_template_id uuid REFERENCES newsletters_block_templates(id) ON DELETE CASCADE;

COMMENT ON COLUMN newsletters_brick_templates.block_template_id IS
  'Links brick template to its parent block template for export/import round-trip fidelity';

-- Enforce only one default template collection at the database level
CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletters_collections_single_default
  ON newsletters_template_collections ((is_default))
  WHERE is_default = TRUE;
