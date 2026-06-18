import { createClient } from '@supabase/supabase-js';
import type { Job } from 'bullmq';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface HygieneJobData {
  kind: string;
}

/**
 * Weekly list hygiene. Suppresses (subscribed=false, not delete) confirmed-dead
 * and stale subscribers via the `suppress_stale_list_subscribers` RPC:
 *   - repeat bouncers (bounced in >= LIST_HYGIENE_MIN_BOUNCE_EDITIONS sends)
 *   - inactive (no open/click in LIST_HYGIENE_INACTIVE_MONTHS months, excluding
 *     recent subscribers). MPP prefetch opens count as activity, so detectably-
 *     reading Apple Mail users are NOT swept.
 *
 * Safety: actual suppression only runs when LIST_HYGIENE_ENABLED='true'.
 * Otherwise the job runs the RPC in **dry-run** mode and just logs the counts
 * it WOULD suppress — so deploying this can't trigger a surprise mass-suppression
 * before an operator has reviewed the numbers (and run the one-off backlog clean).
 */
export default async function handleListHygiene(_job: Job<HygieneJobData>) {
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const enabled = process.env.LIST_HYGIENE_ENABLED === 'true';
  const minBounceEditions = Number(process.env.LIST_HYGIENE_MIN_BOUNCE_EDITIONS ?? 4);
  const inactiveMonths = Number(process.env.LIST_HYGIENE_INACTIVE_MONTHS ?? 6);
  const suppressInactive = process.env.LIST_HYGIENE_SUPPRESS_INACTIVE !== 'false';

  const { data, error } = await supabase.rpc('suppress_stale_list_subscribers', {
    p_list_id: null,
    p_min_bounce_editions: minBounceEditions,
    p_inactive_months: inactiveMonths,
    p_suppress_inactive: suppressInactive,
    p_dry_run: !enabled,
  });
  if (error) throw new Error(`list-hygiene failed: ${error.message}`);

  console.log(
    `[newsletters:list-hygiene] ${enabled ? 'APPLIED' : 'dry-run (LIST_HYGIENE_ENABLED!=true)'} `
    + `bounce>=${minBounceEditions} editions, inactive ${suppressInactive ? inactiveMonths + 'mo' : 'off'}:`,
    JSON.stringify(data),
  );
  return { enabled, result: data };
}
