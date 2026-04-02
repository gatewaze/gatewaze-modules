-- Template Module: Example Migration
-- Replace this with your module's actual schema

-- Example table
CREATE TABLE IF NOT EXISTS public.template_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  data       jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.template_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on template_items"
  ON public.template_items FOR ALL
  USING (auth.role() = 'service_role');
