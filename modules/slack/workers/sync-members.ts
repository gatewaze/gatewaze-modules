// @ts-nocheck — supabase-js resolved at module-host install time.

/**
 * Link every member of the workspace to people: job `slack:sync-members`,
 * data `{ runId }` (a row in integrations_slack_member_syncs).
 *
 * Pages through users.list with the bot token (users:read, users:read.email)
 * and hands each page to integrations_slack_link_members, which writes
 * attributes.slack_user_id onto the matching person and, in 'create' mode,
 * adds anyone missing. Safe to run again: a person whose Slack details have
 * not changed is left untouched.
 *
 * users.list is Tier 2 (about 20 calls a minute), so pages are spaced out and
 * a 429 waits for Slack's Retry-After. A 30,000-member workspace takes ~10
 * minutes. Progress is written after every page, so the admin page can show it.
 */

import { serviceClient } from '../lib/service-client.js';
import { LINK_BATCH_SIZE, isStatementTimeout, toMemberRecord, tallyLinkResults } from '../lib/members.js';
import { SYNCS_TABLE, linkMembers, readSlackConfig, slackApi } from '../lib/welcome-store.js';

const PAGE_GAP_MS = 3500;
const MAX_RATE_LIMIT_WAITS = 20;
const MAX_PAGES = 2000; // 400k members — a runaway cursor stops here

const TIMEOUT_RETRY_GAP_MS = 5000;
const SINGLE_MEMBER_TRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Link one batch. A statement timeout usually means the database is busy, not
 * that the batch is bad: split it and try the halves after a pause, down to
 * single members. A member that still times out is counted as `error` and the
 * sync moves on, so one slow moment cannot end a long run. Other errors throw.
 */
async function linkResilient(sb, records, mode, results) {
  try {
    tallyLinkResults(await linkMembers(sb, records, mode), results);
    return;
  } catch (err) {
    if (!isStatementTimeout(err)) throw err;
  }
  await sleep(TIMEOUT_RETRY_GAP_MS);
  if (records.length > 1) {
    const mid = Math.ceil(records.length / 2);
    await linkResilient(sb, records.slice(0, mid), mode, results);
    await linkResilient(sb, records.slice(mid), mode, results);
    return;
  }
  for (let i = 1; i < SINGLE_MEMBER_TRIES; i++) {
    try {
      tallyLinkResults(await linkMembers(sb, records, mode), results);
      return;
    } catch (err) {
      if (!isStatementTimeout(err)) throw err;
      await sleep(TIMEOUT_RETRY_GAP_MS * (i + 1));
    }
  }
  results.error = (results.error || 0) + 1;
}

export default async function syncMembers(job: { data?: { runId?: string } }) {
  const runId = job?.data?.runId;
  if (!runId) return { skipped: 'no runId' };
  const sb = serviceClient();

  const update = async (patch: Record<string, unknown>) => {
    const { error } = await sb.from(SYNCS_TABLE).update(patch).eq('id', runId);
    if (error) throw new Error(`could not update sync ${runId}: ${error.message}`);
  };

  // Claim the run: only a queued run starts, so a duplicate job is a no-op.
  const { data: claimed, error: claimErr } = await sb
    .from(SYNCS_TABLE)
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', runId)
    .eq('status', 'queued')
    .select('id, mode');
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  const run = claimed && claimed[0];
  if (!run) return { skipped: 'not queued' };

  let pages = 0;
  let seen = 0;
  const results: Record<string, number> = {};
  try {
    const cfg = await readSlackConfig(sb);
    if (!cfg.botToken) throw new Error('No Slack bot token is configured.');

    let cursor = '';
    let rateLimitWaits = 0;
    do {
      const page = await slackApi('users.list', cfg.botToken, { limit: 200, cursor: cursor || undefined });
      if (!page.ok) {
        if (page.error === 'ratelimited' && rateLimitWaits < MAX_RATE_LIMIT_WAITS) {
          rateLimitWaits++;
          await sleep(Math.max(1, Number(page.retryAfter) || 30) * 1000);
          continue;
        }
        throw new Error(`Slack users.list failed: ${page.error}`);
      }

      const members = Array.isArray(page.members) ? page.members : [];
      seen += members.length;
      const records = members.map(toMemberRecord).filter(Boolean);
      for (let i = 0; i < records.length; i += LINK_BATCH_SIZE) {
        await linkResilient(sb, records.slice(i, i + LINK_BATCH_SIZE), run.mode, results);
      }
      pages++;
      await update({ pages, members_seen: seen, results });

      cursor = (page.response_metadata && page.response_metadata.next_cursor) || '';
      if (pages >= MAX_PAGES) throw new Error(`stopped after ${MAX_PAGES} pages`);
      if (cursor) await sleep(PAGE_GAP_MS);
    } while (cursor);

    await update({ status: 'done', finished_at: new Date().toISOString(), pages, members_seen: seen, results, error: null });
    return { pages, seen, results };
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).slice(0, 500);
    await sb.from(SYNCS_TABLE)
      .update({ status: 'failed', finished_at: new Date().toISOString(), pages, members_seen: seen, results, error: message })
      .eq('id', runId);
    // Not retried: a rerun from the admin page starts cleanly, and every
    // page already done is a no-op the second time.
    return { failed: message };
  }
}
