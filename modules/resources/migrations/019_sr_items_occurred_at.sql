-- 019: editorial "as-of" date for a resource item (e.g. the conference date of a
-- recap). Highest-priority input to content_as_of in the version-aware
-- related-content gate (spec-version-aware-related-content.md) — lets an operator
-- pin when a recap's subject matter was current, overriding the talk-video
-- derivation. Nullable; no behaviour change until the projects version engine
-- reads it. Idempotent.
ALTER TABLE public.sr_items ADD COLUMN IF NOT EXISTS occurred_at date;
