// @ts-nocheck — supabase-js resolved at module-host install time.

/**
 * Send one welcome DM: job `slack:welcome-dm`, data `{ logId }`.
 *
 * Queued by the events route with a delay when someone joins. The row is
 * claimed atomically (pending → sending) before anything is sent, so a
 * duplicate job, a redelivered event or a manual retry can never send twice.
 *
 * Nobody is welcomed twice: before posting, the worker reads the DM between
 * the sender and the member, and skips the welcome if either of them has
 * written there already (an earlier welcome from another tool, a reply).
 * A connection that was never granted im:history cannot make that check, so
 * the row is held pending until the sender reconnects and Retry is pressed.
 *
 * Failure handling, by Slack's error code (lib/welcome.js classifySlackError):
 *   auth       — the sender's token stopped working. The connection is marked
 *                broken, the row goes back to pending, and nothing is retried
 *                until someone reconnects and presses Retry.
 *   permanent  — this person cannot be messaged. Row → failed.
 *   retry      — rate limits, outages, network. Row → pending and the job
 *                throws so BullMQ backs off; the last attempt marks it failed.
 */

import { serviceClient } from '../lib/service-client.js';
import { classifySlackError, missingScopes, renderWelcomeMessage } from '../lib/welcome.js';
import { findPriorDirectMessage, LOG_TABLE, markSenderBroken, readSenderWithToken, readSlackConfig, sendDirectMessage } from '../lib/welcome-store.js';

export default async function welcomeDm(job: { data?: { logId?: string }; attemptsMade?: number; opts?: { attempts?: number } }) {
  const logId = job?.data?.logId;
  if (!logId) return { skipped: 'no logId' };
  const sb = serviceClient();
  const attempt = (job.attemptsMade ?? 0) + 1;
  const lastAttempt = attempt >= (job.opts?.attempts ?? 1);

  const { data: claimed, error: claimErr } = await sb
    .from(LOG_TABLE)
    .update({ status: 'sending', attempts: attempt })
    .eq('id', logId)
    .eq('status', 'pending')
    .select('id, team_id, slack_user_id, first_name, display_name');
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  const row = claimed && claimed[0];
  if (!row) return { skipped: 'not pending' };

  const settle = async (patch: Record<string, unknown>) => {
    const { error } = await sb.from(LOG_TABLE).update(patch).eq('id', row.id);
    if (error) throw new Error(`could not update welcome ${row.id}: ${error.message}`);
    settled = true;
  };
  let settled = false;
  let delivered: { ts?: string; as: string } | null = null;

  // The row is ours now. Anything that throws before it is settled (a config
  // read, the database) hands it back to 'pending' for BullMQ's retry, or
  // marks it failed on the last attempt, instead of stranding it in 'sending'.
  try {
    const cfg = await readSlackConfig(sb);
    if (!cfg.enabled) {
      await settle({ status: 'skipped', skip_reason: 'welcome DMs were turned off before this one was due' });
      return { skipped: 'disabled' };
    }
    const sender = await readSenderWithToken(sb);
    if (!sender) {
      await settle({ status: 'skipped', skip_reason: 'no sender connected' });
      return { skipped: 'no sender' };
    }
    if (sender.team_id !== row.team_id) {
      await settle({ status: 'skipped', skip_reason: 'joined a different workspace from the connected sender' });
      return { skipped: 'team mismatch' };
    }
    if (!sender.token) {
      await markSenderBroken(sb, 'stored token could not be decrypted');
      await settle({ status: 'pending', error: 'sender token could not be decrypted — reconnect and retry' });
      return { held: 'token unreadable' };
    }

    // Held, not skipped or marked broken: a broken sender makes the events
    // route skip later joins outright, and these people are still owed a
    // welcome once the check can run.
    const missing = missingScopes(sender.scopes);
    if (missing.length) {
      await settle({ status: 'pending', error: `sender connection lacks ${missing.join(', ')} — reconnect and retry` });
      return { held: 'missing scope' };
    }

    const text = renderWelcomeMessage(cfg.message, {
      id: row.slack_user_id,
      profile: { first_name: row.first_name || '', real_name: row.display_name || '' },
    });

    let result;
    try {
      const prior = await findPriorDirectMessage(sender.token, row.slack_user_id);
      if (prior.ok && prior.found) {
        await settle({ status: 'skipped', skip_reason: 'already has messages in a DM with the sender' });
        return { skipped: 'prior conversation' };
      }
      result = prior.ok ? await sendDirectMessage(sender.token, row.slack_user_id, text) : prior;
    } catch (err) {
      result = { ok: false, error: 'network_error', detail: String(err) };
    }

    if (result.ok) {
      delivered = { ts: result.ts, as: sender.slack_user_id };
      await settle({ status: 'sent', sent_at: new Date().toISOString(), sent_as: sender.slack_user_id, message_ts: result.ts, error: null });
      return { sent: true };
    }

    // Slack says the token cannot read the DM although the stored scopes say
    // it can (the grant changed in Slack). Hold the row for the same reason
    // as a missing scope above, instead of marking the sender broken.
    if (result.stage === 'history' && result.error === 'missing_scope') {
      await settle({ status: 'pending', error: 'sender connection cannot read DMs (im:history) — reconnect and retry' });
      return { held: 'missing scope' };
    }

    const kind = classifySlackError(result.error);
    if (kind === 'auth') {
      await markSenderBroken(sb, result.error);
      await settle({ status: 'pending', error: `sender connection: ${result.error} — reconnect and retry` });
      return { held: result.error };
    }
    if (kind === 'permanent' || lastAttempt) {
      await settle({ status: 'failed', error: result.error });
      return { failed: result.error };
    }
    await settle({ status: 'pending', error: result.error });
    throw new Error(`slack ${result.error} (attempt ${attempt}) — will retry`);
  } catch (err) {
    if (delivered) {
      // The DM went out; only recording it failed. Never hand this row back to
      // 'pending', or a retry would send it a second time.
      await sb.from(LOG_TABLE)
        .update({ status: 'sent', sent_at: new Date().toISOString(), sent_as: delivered.as, message_ts: delivered.ts, error: null })
        .eq('id', row.id).eq('status', 'sending');
      return { sent: true, recorded: false };
    }
    if (!settled) {
      const patch = lastAttempt
        ? { status: 'failed', error: String(err instanceof Error ? err.message : err).slice(0, 500) }
        : { status: 'pending', error: String(err instanceof Error ? err.message : err).slice(0, 500) };
      await sb.from(LOG_TABLE).update(patch).eq('id', row.id).eq('status', 'sending');
    }
    throw err;
  }
}
