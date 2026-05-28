-- ============================================================================
-- Module: engagement
-- Migration: 006_ambassador_badge_kinds
-- Description: Widens the engagement_badges.rule_kind CHECK constraint to
--              include two new badge kinds contributed by the ambassadors
--              module:
--
--                * 'project_scope' — awarded when sum(awarded_points) for the
--                  person, filtered to ambassador_contributions joined to
--                  ambassador_contribution_projects where project_id matches,
--                  crosses rule_config.min_points.
--                  rule_config = { "project_id": "<uuid>", "min_points": 50 }
--
--                * 'ecosystem' — awarded when COUNT(DISTINCT project_id)
--                  across the person's approved ambassador_contributions
--                  reaches rule_config.distinct_projects.
--                  rule_config = { "distinct_projects": 3 }
--
--              See spec-ambassadors-module.md §5.6 and the engagement-rollup
--              edge function for the matching evaluator handlers.
--
--              The handlers are defined in the engagement-rollup function and
--              are wrapped in an `IF EXISTS` check against
--              public.ambassador_contributions so engagement still works on
--              brands that haven't installed the ambassadors module.
--
--              Idempotent: drops the old constraint with IF EXISTS, then
--              re-adds with the widened allow-list.
-- ============================================================================

ALTER TABLE public.engagement_badges
  DROP CONSTRAINT IF EXISTS engagement_badges_rule_kind_check;

ALTER TABLE public.engagement_badges
  ADD CONSTRAINT engagement_badges_rule_kind_check
  CHECK (rule_kind IN (
    'first',
    'count',
    'threshold',
    'manual',
    'streak',
    'project_scope',
    'ecosystem'
  ));

-- Note: the ambassadors-module migration 005_engagement_wiring.sql separately
-- registers the 'ambassador.contribution.reversal' signal type with
-- default_points = 0. The reversal flow emits negative-points engagement_events
-- directly with that signal — engagement_events has no positivity constraint
-- on `points` (see migrations/001_engagement_tables.sql), so this works
-- without further schema changes here.
