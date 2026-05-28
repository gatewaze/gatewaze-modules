// @ts-nocheck — Deno edge function, runtime types provided by Supabase
/**
 * engagement-rollup
 *
 * Scheduled (5-minute cron) function that:
 *   1. Refreshes engagement_scores_calendar + engagement_scores_global materialised views
 *   2. Drains the engagement_badge_eval_queue and awards earned badges
 *
 * Per spec-engagement-module.md §5.3 + §18.2.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
})

interface Badge {
  id: string
  slug: string
  rule_kind: 'count' | 'threshold' | 'manual' | 'first' | 'streak' | 'project_scope' | 'ecosystem'
  rule_config: Record<string, any>
  scope: 'global' | 'per_calendar'
  is_active: boolean
}

// Cached at module-load time. Re-checked once per drain pass — see drainBadgeEvalQueue.
// The ambassadors module is optional, so we probe for ambassador_contributions
// before attempting project_scope / ecosystem evaluations. This keeps engagement
// fully functional on brands that haven't installed ambassadors. See
// spec-ambassadors-module.md §5.6 and §12 risk #1 — the cross-module read is
// intentional and gated.
let ambassadorTablesAvailable: boolean | null = null

async function detectAmbassadorTables(): Promise<boolean> {
  if (ambassadorTablesAvailable !== null) return ambassadorTablesAvailable
  try {
    // HEAD request — cheap. Errors (e.g. 42P01 undefined_table) → not installed.
    const { error } = await supabase
      .from('ambassador_contributions')
      .select('id', { count: 'exact', head: true })
      .limit(1)
    ambassadorTablesAvailable = !error
  } catch {
    ambassadorTablesAvailable = false
  }
  return ambassadorTablesAvailable
}

async function loadActiveBadges(): Promise<Badge[]> {
  const { data } = await supabase
    .from('engagement_badges')
    .select('id, slug, rule_kind, rule_config, scope, is_active')
    .eq('is_active', true)
  return ((data || []) as Badge[]).filter((b) => b.rule_kind !== 'manual')
}

/** Check whether a single badge should now be awarded to a person */
async function checkBadge(personId: string, badge: Badge): Promise<{ eligible: boolean; calendarId: string | null }[]> {
  const results: { eligible: boolean; calendarId: string | null }[] = []

  const cfg = badge.rule_config || {}

  if (badge.rule_kind === 'first' || badge.rule_kind === 'count') {
    const signal = cfg.signal
    if (!signal) return results
    const needed = badge.rule_kind === 'first' ? 1 : cfg.count || 1

    if (badge.scope === 'global') {
      const { count } = await supabase
        .from('engagement_events')
        .select('id', { count: 'exact', head: true })
        .eq('person_id', personId)
        .eq('signal', signal)
      if ((count || 0) >= needed) results.push({ eligible: true, calendarId: null })
    } else {
      // per_calendar: get per-calendar counts
      const { data } = await supabase
        .from('engagement_events')
        .select('calendar_id')
        .eq('person_id', personId)
        .eq('signal', signal)
        .not('calendar_id', 'is', null)
      const counts = new Map<string, number>()
      for (const row of data || []) {
        const cid = (row as any).calendar_id
        counts.set(cid, (counts.get(cid) || 0) + 1)
      }
      for (const [cid, n] of counts) {
        if (n >= needed) results.push({ eligible: true, calendarId: cid })
      }
    }
  } else if (badge.rule_kind === 'threshold') {
    const minPoints = cfg.min_points || 0
    if (badge.scope === 'global') {
      const { data } = await supabase
        .from('engagement_scores_global')
        .select('total_points')
        .eq('person_id', personId)
        .maybeSingle()
      if (((data as any)?.total_points || 0) >= minPoints) {
        results.push({ eligible: true, calendarId: null })
      }
    } else {
      const { data } = await supabase
        .from('engagement_scores_calendar')
        .select('calendar_id, total_points')
        .eq('person_id', personId)
      for (const row of data || []) {
        if (((row as any).total_points || 0) >= minPoints) {
          results.push({ eligible: true, calendarId: (row as any).calendar_id })
        }
      }
    }
  } else if (badge.rule_kind === 'project_scope') {
    // Cross-module: reads from public.ambassador_contributions and
    // public.ambassador_contribution_projects. Intentional per
    // spec-ambassadors-module.md §5.6 + §12 risk #1. Gated on table existence
    // so engagement keeps working without the ambassadors module installed.
    const projectId = cfg.project_id as string | undefined
    const minPoints = Number(cfg.min_points ?? 0)
    if (!projectId || !(await detectAmbassadorTables())) return results

    const result = await evaluateProjectScopeBadge(personId, projectId)
    if (result >= minPoints) {
      results.push({ eligible: true, calendarId: null })
    }
  } else if (badge.rule_kind === 'ecosystem') {
    // Cross-module: see project_scope note above.
    const distinctProjectsNeeded = Number(cfg.distinct_projects ?? 0)
    if (distinctProjectsNeeded <= 0 || !(await detectAmbassadorTables())) return results

    const distinct = await evaluateEcosystemBadge(personId)
    if (distinct >= distinctProjectsNeeded) {
      results.push({ eligible: true, calendarId: null })
    }
  }
  // streak kind is left for a follow-up — requires windowed queries

  return results
}

/**
 * Sum of awarded_points across the person's approved ambassador_contributions
 * scoped to a single project (via ambassador_contribution_projects).
 *
 * SQL equivalent:
 *   SELECT COALESCE(SUM(c.awarded_points), 0) AS pts
 *   FROM   public.ambassador_contributions c
 *   JOIN   public.ambassador_contribution_projects cp ON cp.contribution_id = c.id
 *   JOIN   public.ambassador_profiles pr ON pr.id = c.ambassador_id
 *   WHERE  pr.person_id = $1 AND cp.project_id = $2 AND c.status = 'approved'
 *
 * Cross-module read — engagement does not depend on the ambassadors npm package.
 * The integration is SQL-level only.
 */
async function evaluateProjectScopeBadge(personId: string, projectId: string): Promise<number> {
  // We call a SECURITY DEFINER RPC if the ambassadors module ships one;
  // otherwise fall back to the join via Supabase PostgREST embeds.
  const { data, error } = await supabase
    .from('ambassador_contributions')
    .select(
      'awarded_points, status, ambassador_profiles!inner(person_id), ambassador_contribution_projects!inner(project_id)'
    )
    .eq('status', 'approved')
    .eq('ambassador_profiles.person_id', personId)
    .eq('ambassador_contribution_projects.project_id', projectId)

  if (error || !data) return 0
  return (data as any[]).reduce((sum, row) => sum + Number(row.awarded_points || 0), 0)
}

/**
 * Count of DISTINCT project_id across the person's approved
 * ambassador_contributions.
 *
 * SQL equivalent:
 *   SELECT COUNT(DISTINCT cp.project_id) AS distinct_projects
 *   FROM   public.ambassador_contributions c
 *   JOIN   public.ambassador_contribution_projects cp ON cp.contribution_id = c.id
 *   JOIN   public.ambassador_profiles pr ON pr.id = c.ambassador_id
 *   WHERE  pr.person_id = $1 AND c.status = 'approved'
 */
async function evaluateEcosystemBadge(personId: string): Promise<number> {
  const { data, error } = await supabase
    .from('ambassador_contributions')
    .select(
      'ambassador_profiles!inner(person_id), ambassador_contribution_projects!inner(project_id)'
    )
    .eq('status', 'approved')
    .eq('ambassador_profiles.person_id', personId)

  if (error || !data) return 0
  const projectIds = new Set<string>()
  for (const row of data as any[]) {
    const tags = row.ambassador_contribution_projects
    if (Array.isArray(tags)) {
      for (const t of tags) if (t?.project_id) projectIds.add(t.project_id)
    } else if (tags?.project_id) {
      projectIds.add(tags.project_id)
    }
  }
  return projectIds.size
}

async function drainBadgeEvalQueue(): Promise<{ evaluated: number; awarded: number }> {
  // Reset ambassador-table availability cache once per drain so admins can
  // install / uninstall the ambassadors module without restarting the worker.
  ambassadorTablesAvailable = null

  // Claim a batch
  const { data: pendingRows } = await supabase
    .from('engagement_badge_eval_queue')
    .select('*')
    .eq('status', 'pending')
    .order('enqueued_at')
    .limit(100)

  if (!pendingRows || pendingRows.length === 0) return { evaluated: 0, awarded: 0 }

  // Deduplicate by person_id — one evaluation covers all their outstanding rows
  const personIds = [...new Set(pendingRows.map((r: any) => r.person_id))]
  const badges = await loadActiveBadges()
  let awarded = 0

  for (const personId of personIds) {
    for (const badge of badges) {
      const eligibility = await checkBadge(personId, badge)
      for (const elig of eligibility) {
        if (!elig.eligible) continue
        // Upsert member_badges row
        const { error } = await supabase
          .from('engagement_member_badges')
          .insert({
            person_id: personId,
            badge_id: badge.id,
            calendar_id: elig.calendarId,
          })
        if (!error) awarded++
        // Duplicate key violations are expected and silently ignored
      }
    }
  }

  // Mark all processed
  const ids = pendingRows.map((r: any) => r.id)
  await supabase
    .from('engagement_badge_eval_queue')
    .update({ status: 'processed', processed_at: new Date().toISOString() })
    .in('id', ids)

  return { evaluated: personIds.length, awarded }
}

async function handler(_req: Request): Promise<Response> {
  try {
    // 1. Refresh materialised views
    const { error: refreshErr } = await supabase.rpc('engagement_refresh_views')
    if (refreshErr) {
      console.error('engagement_refresh_views failed:', refreshErr)
    }

    // 2. Drain badge eval queue
    const badgeResult = await drainBadgeEvalQueue()

    return new Response(
      JSON.stringify({
        data: { refreshed: !refreshErr, ...badgeResult },
        error: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (e: any) {
    console.error('engagement-rollup failed:', e)
    return new Response(
      JSON.stringify({ data: null, error: { code: 'INTERNAL', message: e?.message || String(e) } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}

Deno.serve(handler)
