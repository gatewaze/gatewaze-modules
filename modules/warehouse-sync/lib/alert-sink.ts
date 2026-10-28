/**
 * Where a §10.4 alert actually goes.
 *
 * Detection was never the problem. On 2026-10-28 the slot monitor raised
 * "slot WAL is unreserved — restart the connector now or the slot is lost" at
 * 06:45, inside the window where the slot is still recoverable, and nothing
 * happened: syncs had been failing since 22 Oct and the slot was lost by the
 * time anyone looked. The alert had nowhere to go, because `alertWebhookUrl`
 * was never configured and no incoming webhook existed anywhere in the brand.
 *
 * So this supports two sinks, and prefers whichever is configured:
 *
 *   1. `alertWebhookUrl` — a Slack/PagerDuty-compatible incoming webhook.
 *   2. `alertSlackChannel` + the slack module's `SLACK_BOT_TOKEN` — posts via
 *      chat.postMessage. This needs nothing new provisioned: the token is
 *      already present for welcome DMs, and a channel id OR a user id works
 *      (a user id opens a DM), so an operator can be paged directly.
 *
 * Returns true only when the alert was actually accepted by the sink, because
 * the caller records that as `notified` and will not re-page an open alert.
 */

export interface AlertLike {
  slot_name: string | null;
  code: string;
  severity: string;
  message: string;
}

interface Logger {
  warn?: (m: string) => void;
  info?: (m: string) => void;
}

/** Human-readable one-liner used by every sink. */
export function formatAlert(alert: AlertLike): string {
  const where = alert.slot_name ? `${alert.slot_name}/${alert.code}` : alert.code;
  return `:rotating_light: [warehouse-sync] ${String(alert.severity).toUpperCase()} ${where}: ${alert.message}`;
}

/** POST to an incoming webhook. */
export async function postWebhook(url: string, alert: AlertLike, logger: Logger = {}): Promise<boolean> {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: formatAlert(alert) }),
    });
    return res.ok;
  } catch (e) {
    logger.warn?.(`[warehouse-sync] webhook post failed: ${(e as Error)?.message ?? e}`);
    return false;
  }
}

/**
 * Post via the Slack Web API with a bot token. `channel` may be a channel id,
 * a #name, or a user id (which opens a DM). Slack returns HTTP 200 with
 * `{ok: false, error}` on failure, so the body must be checked, not just the
 * status.
 */
export async function postSlackBot(
  token: string,
  channel: string,
  alert: AlertLike,
  logger: Logger = {},
): Promise<boolean> {
  if (!token || !channel) return false;
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel, text: formatAlert(alert) }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!body.ok) {
      logger.warn?.(`[warehouse-sync] slack post failed: ${body.error ?? `HTTP ${res.status}`}`);
      return false;
    }
    return true;
  } catch (e) {
    logger.warn?.(`[warehouse-sync] slack post failed: ${(e as Error)?.message ?? e}`);
    return false;
  }
}

/**
 * Deliver an alert to whichever sink is configured. The Slack bot token is read
 * from the slack module's own config rather than duplicated into this module's,
 * so there is one place to rotate it.
 */
export async function deliverAlert(
  alert: AlertLike,
  cfg: Record<string, unknown>,
  supabase: { from: (t: string) => any },
  logger: Logger = {},
): Promise<boolean> {
  const webhookUrl = (cfg.alertWebhookUrl as string) || '';
  if (webhookUrl) return postWebhook(webhookUrl, alert, logger);

  const channel = (cfg.alertSlackChannel as string) || '';
  if (!channel) return false;

  try {
    const { data } = await supabase
      .from('installed_modules')
      .select('config')
      .eq('id', 'slack')
      .maybeSingle();
    const token = ((data?.config ?? {}) as Record<string, unknown>).SLACK_BOT_TOKEN as string;
    if (!token) {
      logger.warn?.('[warehouse-sync] alertSlackChannel set but the slack module has no SLACK_BOT_TOKEN');
      return false;
    }
    return postSlackBot(token, channel, alert, logger);
  } catch (e) {
    logger.warn?.(`[warehouse-sync] could not read slack token: ${(e as Error)?.message ?? e}`);
    return false;
  }
}
