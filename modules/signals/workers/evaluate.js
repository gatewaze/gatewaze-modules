/**
 * BullMQ handler for signals:evaluate.
 *
 * Evaluates every active rule whose interval_minutes has elapsed and
 * dispatches the resulting fires through their channels. Scheduled by the
 * platform's cron worker; also runnable on demand through the manage API's
 * POST /signals/evaluate-due (which shares lib/engine.js with this handler).
 */
const { createClient } = require('@supabase/supabase-js');
const { evaluateDueRules } = require('../lib/engine.js');

module.exports = async function evaluate(job) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[signals:evaluate] missing SUPABASE env');
  const supabase = createClient(url, key);

  const results = await evaluateDueRules(supabase, { force: job?.data?.force === true });
  for (const r of results) {
    console.log(JSON.stringify({ event: 'signals.evaluate', ...r }));
  }
  return { rules_evaluated: results.length };
};
