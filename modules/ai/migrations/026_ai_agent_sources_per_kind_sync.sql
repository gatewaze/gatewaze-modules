-- Per-kind sync commit tracking on ai_agent_sources.
--
-- Bug: the skill sync pass and the recipe sync pass both shared
-- ai_agent_sources.last_synced_commit for their HEAD-SHA fast-path.
-- The orchestrator runs skills first; skill sync writes the new SHA;
-- recipe sync then reads that SHA, compares it against HEAD, sees a
-- match, and short-circuits with `recipesIndexed: 0`. Recipes were
-- silently never indexed unless the file changed in the same commit
-- as a skill file *and* the recipe sync happened to run first — i.e.
-- almost never on real repos.
--
-- Fix: each pass gets its own last-synced column. The legacy
-- last_synced_commit column stays for backward-compatible display
-- (admin UI shows the most recent overall sync). It is updated by
-- both passes' releaseLock; since both syncs read the same HEAD,
-- the value converges on the latest commit either way.

ALTER TABLE ai_agent_sources
  ADD COLUMN IF NOT EXISTS last_synced_skills_commit  text,
  ADD COLUMN IF NOT EXISTS last_synced_recipes_commit text;

-- Backfill: any source that already synced once has the same SHA for
-- both kinds (the old shared column was last written by whichever pass
-- ran second, which observed the same HEAD).
UPDATE ai_agent_sources
   SET last_synced_skills_commit  = COALESCE(last_synced_skills_commit,  last_synced_commit),
       last_synced_recipes_commit = COALESCE(last_synced_recipes_commit, last_synced_commit)
 WHERE last_synced_commit IS NOT NULL;
