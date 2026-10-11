-- ============================================================================
-- Module: broadcasts
-- Migration: 027_broadcast_template
-- Description: Which email shell a broadcast renders with. 'plain' is the
-- built-in plain-email wrapper (reads like a message typed in Gmail: no
-- column, the reader's own font and colours, unsubscribe as plain text);
-- 'classic' is the standard 600px column with the platform font stack.
-- New broadcasts default to plain; existing ones keep the look they were
-- written for.
-- ============================================================================
ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS template text NOT NULL DEFAULT 'plain';

UPDATE public.broadcasts SET template = 'classic' WHERE template = 'plain' AND rendered_html IS NOT NULL;

ALTER TABLE public.broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_template_check;
ALTER TABLE public.broadcasts
  ADD CONSTRAINT broadcasts_template_check CHECK (template IN ('plain', 'classic'));
