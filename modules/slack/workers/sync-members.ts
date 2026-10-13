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
import { LINK_BATCH_SIZE, toMemberRecord, tallyLinkResults } from '../lib/members.js';
import { SYNCS_TABLE, linkMembers, readSlackConfig, slackApi } from '../lib/welcome-store.js';

const PAGE_GAP_MS = 3500;
const MAX_RATE_LIMIT_WAITS = 20;
const MAX_PAGES = 2000; // 400k members — a runaway cursor stops here

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
        tallyLinkResults(await linkMembers(sb, records.slice(i, i + LINK_BATCH_SIZE), run.mode), results);
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
