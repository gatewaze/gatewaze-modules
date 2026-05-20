-- spec-ai-mcp-extensions.md §Data Models §Use-case templates.
--
-- Curated bundles of (model, allowed_web_tools, suggested MCP
-- allowlist, goose_runtime_overrides) that operators apply when
-- creating a new use case. Built-in templates ship with is_builtin=true
-- and are immutable (PATCH/DELETE 409). Operator-defined templates
-- are mutable.

CREATE TABLE IF NOT EXISTS public.ai_use_case_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  name            text NOT NULL CHECK (name ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  display_name    text NOT NULL,
  description     text NOT NULL,

  is_builtin      boolean NOT NULL DEFAULT false,

  suggested_provider                  text,
  suggested_model                     text,
  suggested_allowed_web_tools         jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggested_allowed_mcp_server_names  jsonb NOT NULL DEFAULT '[]'::jsonb,
  goose_runtime_overrides             jsonb NOT NULL DEFAULT '{}'::jsonb,
  hint_recipe_file_pattern            text,
  hint_skill_dir_pattern              text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,

  CONSTRAINT ai_use_case_templates_web_tools_array CHECK (jsonb_typeof(suggested_allowed_web_tools) = 'array'),
  CONSTRAINT ai_use_case_templates_mcp_array      CHECK (jsonb_typeof(suggested_allowed_mcp_server_names) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_use_case_templates_name_key
  ON public.ai_use_case_templates(name);

-- Same validator as ai_use_cases — keeps the allowlist in lockstep.
DROP TRIGGER IF EXISTS ai_use_case_templates_validate_goose_overrides ON public.ai_use_case_templates;
CREATE TRIGGER ai_use_case_templates_validate_goose_overrides
  BEFORE INSERT OR UPDATE OF goose_runtime_overrides ON public.ai_use_case_templates
  FOR EACH ROW EXECUTE FUNCTION public.validate_goose_runtime_overrides();

-- Built-in template-name reservation.
CREATE OR REPLACE FUNCTION public.reject_reserved_template_names()
RETURNS trigger AS $$
DECLARE
  reserved CONSTANT text[] := ARRAY['research','interactive-chat-approval','image-gen','brief-qa','recipe-autopilot'];
BEGIN
  IF NEW.name = ANY(reserved) AND NOT NEW.is_builtin THEN
    RAISE EXCEPTION 'template name % is reserved for built-in templates', NEW.name
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_use_case_templates_reserved_names ON public.ai_use_case_templates;
CREATE TRIGGER ai_use_case_templates_reserved_names
  BEFORE INSERT OR UPDATE OF name, is_builtin ON public.ai_use_case_templates
  FOR EACH ROW EXECUTE FUNCTION public.reject_reserved_template_names();

CREATE OR REPLACE FUNCTION public.touch_ai_use_case_templates_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_use_case_templates_touch_updated_at
  BEFORE UPDATE ON public.ai_use_case_templates
  FOR EACH ROW EXECUTE FUNCTION public.touch_ai_use_case_templates_updated_at();

ALTER TABLE public.ai_use_case_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_use_case_templates_select_authenticated ON public.ai_use_case_templates
  FOR SELECT TO authenticated USING (true);
CREATE POLICY ai_use_case_templates_service_role_all ON public.ai_use_case_templates
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Adopted-template tracking on ai_use_cases.
ALTER TABLE public.ai_use_cases
  ADD COLUMN IF NOT EXISTS template_id     uuid REFERENCES public.ai_use_case_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS template_drifted boolean NOT NULL DEFAULT false;

COMMENT ON TABLE public.ai_use_case_templates IS
  'Curated bundles of suggested defaults that new use cases adopt as starting configuration. spec-ai-mcp-extensions.md.';
