-- Site personas + page variants (per spec-example-theme-deliverable.md §5.2,
-- §7.4 — the editor-side data layer for the runtime content API and
-- per-persona variant resolution).
--
-- Two new tables:
--   - site_personas   : the named segments per site (Developer, Enterprise, …)
--                       with resolution rules (URL params, UTM, self-select).
--                       Replaces / supersedes `theme.json.personas` as a
--                       static string list, putting persona definitions
--                       behind the admin UI.
--   - page_variants   : per-field editorial overlays on `pages.content`.
--                       Defaults remain in `pages.content`; this is the
--                       sidecar that records "for THIS persona, override
--                       THIS field with THIS value." Optional opt-in —
--                       absence of a variant falls back to the default.
--
-- Both follow the same single-tenant-per-deployment model as the rest of
-- the schema — no `tenant_id` column.

-- ---------------------------------------------------------------------------
-- 1. site_personas
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS site_personas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,

  -- Identity
  name        text NOT NULL,                  -- slug-style: "developer", "enterprise"
  label       text NOT NULL,                  -- display: "Developer", "Enterprise buyer"
  description text,                           -- editor-facing helper text

  -- Default + ordering
  is_default  boolean NOT NULL DEFAULT false,
  priority    integer NOT NULL DEFAULT 100,   -- evaluation priority — lower checked first
                                              -- when multiple personas match a request

  -- Resolution rules.
  --
  -- Shape: jsonb array of `{ axis, operator, value, persist }` objects.
  --   axis     : any canonical `RenderContext` axis path, e.g.
  --              "persona", "utm.campaign", "utm.source", "utm.medium",
  --              "utm.term", "utm.content", "geo.country", "geo.region",
  --              "geo.city", "locale", "viewer.authenticated".
  --              Plus a pseudo-axis "*self_select" for the case where
  --              the editor wants the persona to be eligible for
  --              cookie-stored explicit selection.
  --   operator : 'eq' | 'in' | 'exists' | 'not_eq'
  --   value    : the comparison target.
  --                eq / not_eq → string or boolean
  --                in          → array of strings
  --                exists      → null (operator alone defines the check)
  --   persist  : boolean — when true, the resolved persona is sticky in
  --              the `example_persona` (or equivalent) cookie. The cookie
  --              is set by client code, not by the resolver.
  --
  -- Example for an "enterprise" persona:
  --   [
  --     { "axis": "persona",       "operator": "eq", "value": "enterprise", "persist": true },
  --     { "axis": "utm.campaign",  "operator": "in", "value": ["enterprise-summit","q4-enterprise"], "persist": true },
  --     { "axis": "geo.country",   "operator": "in", "value": ["GB","US","DE"], "persist": false },
  --     { "axis": "*self_select",  "operator": "eq", "value": null,        "persist": true }
  --   ]
  --
  -- Validation rules (enforced at the application layer because PG's
  -- jsonpath is unwieldy for nested checks):
  --   - axis required, must be a known RenderContext axis or '*self_select'
  --   - operator required, must be one of the four
  --   - value shape must match the operator (eq → scalar; in → array; exists → null)
  --   - persist is optional, defaults to false
  --
  -- Why open-axis instead of a closed enum: §RenderContext is itself
  -- extensible — adding referrer.domain or device.type as a new
  -- canonical axis is a code change to the canonicaliser, NOT a
  -- migration. Keeping conditions open at the persona layer means
  -- new axes flow through without touching this table.
  conditions  jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES auth.users(id),

  -- Per-site uniqueness on the slug — operators get a clean "this persona
  -- name is already in use" error rather than silent duplication.
  UNIQUE (site_id, name),

  -- Name must be a clean slug — used as the cookie value and in URL params
  -- so anything that'd need encoding is rejected. Lowercase + dash only.
  CONSTRAINT site_personas_name_slug_safe
    CHECK (name ~ '^[a-z][a-z0-9-]*$' AND length(name) BETWEEN 1 AND 64),

  -- Conditions must be an array (not an object / scalar). Per-element
  -- shape is validated at the application layer; doing it in PG with
  -- jsonpath gets ugly fast.
  CONSTRAINT site_personas_conditions_is_array
    CHECK (jsonb_typeof(conditions) = 'array')
);

CREATE INDEX IF NOT EXISTS site_personas_site_priority_idx
  ON site_personas (site_id, priority);

-- Exactly one default per site. Enforce via a partial unique index so
-- inserts that try to set a second default surface a clear constraint
-- violation rather than silently coexisting.
CREATE UNIQUE INDEX IF NOT EXISTS site_personas_one_default_per_site_idx
  ON site_personas (site_id)
  WHERE is_default = true;

-- ---------------------------------------------------------------------------
-- 2. page_variants
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS page_variants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id       uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,

  -- Field path inside `pages.content` this variant overrides. Dot-separated
  -- with bracket notation for arrays — matches the convention used by other
  -- JSON-path libs:
  --   "heroTitle"
  --   "hero.subtitle"
  --   "contentBlocks"               (whole-array replacement / reorder)
  --   "contentBlocks[2].title"      (specific block field — rare; usually
  --                                  the array is what gets personalized)
  field_path    text NOT NULL,

  -- Match context — the canonical flat RenderContext subset that activates
  -- this variant. Shape: `{ "axis.key": "value" }` or `{ "axis.key": ["v1","v2"] }`.
  -- Empty object means "always applies" (unusual — typically there's at
  -- least one axis specified).
  --
  -- Examples:
  --   { "persona": "enterprise" }
  --   { "persona": ["enterprise","developer"] }
  --   { "utm.campaign": "mcp-security" }
  --   { "persona": "developer", "utm.campaign": "mcp-launch" }
  match_context jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The replacement value. Shape matches the field's schema at field_path:
  --   - strings/numbers/booleans → primitive
  --   - objects → full sub-object
  --   - arrays → full array (reorder/filter happens by replacing the array)
  value         jsonb NOT NULL,

  -- Editor priority — when two variants both match a request, lower wins.
  -- Default 100. Useful when two persona+utm combinations overlap and the
  -- editor wants explicit control over precedence.
  priority      integer NOT NULL DEFAULT 100,

  -- Optional FK back to site_personas — purely for the admin UX (so a
  -- variant can be displayed as "Enterprise — Hero title"). The actual
  -- resolution uses `match_context`, not this column, so the link can be
  -- broken without breaking resolution. ON DELETE SET NULL keeps the
  -- variant alive if the persona is deleted; the editor sees "(deleted
  -- persona)" and decides what to do with the orphaned variant.
  persona_id    uuid REFERENCES site_personas(id) ON DELETE SET NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES auth.users(id),

  -- One variant per (page, field, match_context) — duplicate authoring
  -- (e.g. two variants both targeting `{persona: enterprise}` on the same
  -- field) is editor error; surface it.
  --
  -- match_context is jsonb; PG can index it for uniqueness with a btree
  -- on its sorted-text representation. We use a stable canonicaliser at
  -- the app layer to ensure equivalent contexts hash identically.
  UNIQUE (page_id, field_path, match_context),

  -- Field path must be non-empty and reasonably sized. The application
  -- layer parses it; here we just bound it.
  CONSTRAINT page_variants_field_path_nonempty
    CHECK (length(field_path) BETWEEN 1 AND 500),

  CONSTRAINT page_variants_match_context_is_object
    CHECK (jsonb_typeof(match_context) = 'object')
);

CREATE INDEX IF NOT EXISTS page_variants_page_idx
  ON page_variants (page_id);

-- Persona-centric lookups (e.g. "show me everything authored for the
-- Enterprise persona" in the matrix view).
CREATE INDEX IF NOT EXISTS page_variants_persona_idx
  ON page_variants (persona_id)
  WHERE persona_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. updated_at triggers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION site_personas_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS site_personas_updated_at_trigger ON site_personas;
CREATE TRIGGER site_personas_updated_at_trigger
  BEFORE UPDATE ON site_personas
  FOR EACH ROW EXECUTE FUNCTION site_personas_set_updated_at();

CREATE OR REPLACE FUNCTION page_variants_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS page_variants_updated_at_trigger ON page_variants;
CREATE TRIGGER page_variants_updated_at_trigger
  BEFORE UPDATE ON page_variants
  FOR EACH ROW EXECUTE FUNCTION page_variants_set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------

-- site_personas — admins of the owning site can read + write.
-- Other modules (newsletters, etc.) don't touch this table.
ALTER TABLE site_personas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS site_personas_read_admin ON site_personas;
CREATE POLICY site_personas_read_admin ON site_personas
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admin_profiles
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS site_personas_write_admin ON site_personas;
CREATE POLICY site_personas_write_admin ON site_personas
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admin_profiles
      WHERE user_id = auth.uid() AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admin_profiles
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

-- page_variants — same policy. Service-role writes from the publish-time
-- emitter bypass RLS as usual.
ALTER TABLE page_variants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS page_variants_read_admin ON page_variants;
CREATE POLICY page_variants_read_admin ON page_variants
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admin_profiles
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS page_variants_write_admin ON page_variants;
CREATE POLICY page_variants_write_admin ON page_variants
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admin_profiles
      WHERE user_id = auth.uid() AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admin_profiles
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

-- ---------------------------------------------------------------------------
-- 5. (Future) — explicit referential index on pages.id from page_variants
-- ---------------------------------------------------------------------------

-- Already covered by the FK definition above. Noted here so the next
-- migration touching pages knows pageinvariant lookups are O(log n) by
-- page_id (page_variants_page_idx) and O(log n) by persona_id
-- (page_variants_persona_idx).
