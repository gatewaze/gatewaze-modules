/**
 * Runtime access shared by the welcome-DM routes and worker: the module's
 * config (secrets unsealed), the connected sender, and the Slack Web API.
 *
 * Nothing here ever returns a token to a caller outside the server; the
 * routes only ever see the non-secret columns.
 */

import { unsealSecret } from './secret-envelope.js';
import { DEFAULT_DELAY_MINUTES, WELCOME_PURPOSE } from './welcome.js';

export const TOKENS_TABLE = 'integrations_slack_user_tokens';
export const LOG_TABLE = 'integrations_slack_welcome_log';
export const SENDER_COLUMNS = 'purpose, team_id, slack_user_id, slack_user_name, scopes, connected_by, connected_at, status, status_detail, updated_at';

const CONFIG_TTL_MS = 30 * 1000;
let configCache = null;

/** Drop the cached config, e.g. right after the admin page saved new settings. */
export function invalidateConfig() {
  configCache = null;
}

/**
 * The slack module's config from installed_modules, with secrets unsealed.
 *
 * A secret that is sealed but cannot be opened comes back as null, never as
 * ciphertext: a signing secret that silently became the ciphertext would make
 * every request look forged, and a client secret would fail the exchange in a
 * confusing way.
 */
export async function readSlackConfig(sb) {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.value;
  const { data, error } = await sb.from('installed_modules').select('config').eq('id', 'slack').maybeSingle();
  if (error) throw new Error(`could not read slack module config: ${error.message}`);
  const c = (data && data.config) || {};
  const str = (k) => (typeof c[k] === 'string' ? c[k].trim() : '');
  const bool = (k) => c[k] === true || c[k] === 'true';
  const delay = Number(c.SLACK_WELCOME_DELAY_MINUTES);
  const value = {
    clientId: str('SLACK_CLIENT_ID'),
    clientSecret: unsealSecret(str('SLACK_CLIENT_SECRET')) || '',
    signingSecret: unsealSecret(str('SLACK_SIGNING_SECRET')) || '',
    botToken: unsealSecret(str('SLACK_BOT_TOKEN')) || '',
    enabled: bool('SLACK_WELCOME_ENABLED'),
    message: typeof c.SLACK_WELCOME_MESSAGE === 'string' ? c.SLACK_WELCOME_MESSAGE : '',
    delayMinutes: Number.isFinite(delay) && delay >= 0 ? delay : DEFAULT_DELAY_MINUTES,
  };
  configCache = { at: Date.now(), value };
  return value;
}

/** The connected sender WITHOUT the token. For status pages and checks. */
export async function readSender(sb) {
  const { data, error } = await sb.from(TOKENS_TABLE).select(SENDER_COLUMNS).eq('purpose', WELCOME_PURPOSE).maybeSingle();
  if (error) throw new Error(`could not read the connected sender: ${error.message}`);
  return data || null;
}

/**
 * The connected sender WITH its token unsealed. Server-side use only.
 *
 * @returns null when nobody is connected; `{..., token: null}` when a row
 *   exists but the token cannot be unsealed (wrong or missing key).
 */
export async function readSenderWithToken(sb) {
  const { data, error } = await sb.from(TOKENS_TABLE).select(`${SENDER_COLUMNS}, token_sealed`).eq('purpose', WELCOME_PURPOSE).maybeSingle();
  if (error) throw new Error(`could not read the connected sender: ${error.message}`);
  if (!data) return null;
  const { token_sealed: sealed, ...rest } = data;
  return { ...rest, token: unsealSecret(sealed) };
}

/** Record that the connected account stopped working, so the admin page says so. */
export async function markSenderBroken(sb, detail) {
  await sb.from(TOKENS_TABLE)
    .update({ status: 'broken', status_detail: String(detail).slice(0, 200), updated_at: new Date().toISOString() })
    .eq('purpose', WELCOME_PURPOSE);
}

/**
 * Call a Slack Web API method.
 *
 * Form-encoded POST, which every method accepts. Never throws on a Slack
 * error: the result carries `ok:false` and the `error` code so the caller can
 * classify it. Network failures come back as `error: 'network_error'`.
 */
export async function slackApi(method, token, params = {}, fetchImpl = fetch) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, String(v));
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetchImpl(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { ok: false, error: 'network_error', detail: err && err.message ? err.message : String(err) };
  }
  if (res.status === 429) {
    return { ok: false, error: 'ratelimited', retryAfter: Number(res.headers.get('retry-after')) || null };
  }
  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: `http_${res.status}` };
  }
  return json && typeof json === 'object' ? json : { ok: false, error: 'bad_response' };
}

/** Send a DM from the sender's own account: open the IM, then post in it. */
export async function sendDirectMessage(token, slackUserId, text, fetchImpl = fetch) {
  const open = await slackApi('conversations.open', token, { users: slackUserId }, fetchImpl);
  if (!open.ok) return { ok: false, error: open.error || 'conversations_open_failed', stage: 'open' };
  const channel = open.channel && open.channel.id;
  if (!channel) return { ok: false, error: 'no_channel', stage: 'open' };
  const post = await slackApi('chat.postMessage', token, {
    channel,
    text,
    unfurl_links: false,
    unfurl_media: false,
  }, fetchImpl);
  if (!post.ok) return { ok: false, error: post.error || 'post_failed', stage: 'post' };
  return { ok: true, channel, ts: post.ts };
}
