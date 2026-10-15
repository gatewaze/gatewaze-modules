// @ts-nocheck — bullmq/pg types are resolved at module-host install time.
/**
 * Every 2 hours: rebuild segments_email_activity (latest send, open and click
 * per address) for the "Any email activity" audience condition.
 *
 * The rebuild reads all of email_send_log (6M rows on AAIF, about a minute),
 * so it runs over the worker's direct database connection with a 5 minute
 * statement limit. PostgREST's 8s limit can never fit it, so without a
 * DATABASE_URL the job logs and skips; the condition then treats the summary
 * as missing (includes match nobody, excludes exclude nobody).
 */

import pg from 'pg';
import type { Job } from 'bullmq';

const STATEMENT_TIMEOUT = '300s';

export default async function handler(_job: Job): Promise<unknown> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[segments] refresh-email-activity skipped: DATABASE_URL is not set');
    return { skipped: 'no DATABASE_URL' };
  }
  const c = new pg.Client({ connectionString: url, application_name: 'segments-email-activity' });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    const { rows } = await c.query('SELECT public.segments_refresh_email_activity() AS r');
    await c.query('COMMIT');
    const result = rows[0]?.r ?? null;
    console.log('[segments] refresh-email-activity', JSON.stringify(result));
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end().catch(() => undefined);
  }
}
