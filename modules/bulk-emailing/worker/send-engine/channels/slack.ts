/**
 * Slack ChannelProvider: a direct message to one Slack member per call
 * (conversations.open, then chat.postMessage in the IM it returns).
 *
 * Slack has no multi-recipient send, and a partly delivered batch cannot be
 * retried without messaging some people twice, so this provider takes exactly
 * one personalization per call (maxPerCall) and the engine paces the calls.
 *
 * The token comes from the binding (msg.auth), which reads it from the slack
 * module's sealed config; it never leaves the worker.
 *
 * Failures, by Slack's error code:
 *   auth       the token no longer works or lacks a scope. Every later message
 *              would fail the same way, so the send is paused (haltSend).
 *   permanent  this member cannot be messaged (deactivated, not found). The
 *              recipient is marked failed.
 *   retry      rate limits, outages, network errors, unknown codes. The
 *              recipient goes back to pending; Retry-After is passed on.
 */
import type { Recipient } from '../engine.js';
import type { ChannelProvider, BatchedMessage, BatchedResult } from './types.js';

const SLACK_API = 'https://slack.com/api';
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;
// Slack truncates longer messages; the admin editor enforces the same limit.
export const MAX_SLACK_MESSAGE_CHARS = 4000;

const AUTH_ERRORS = new Set([
  'invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive',
  'missing_scope', 'no_permission', 'ekm_access_denied', 'not_allowed_token_type', 'team_access_not_granted',
]);
const PERMANENT_ERRORS = new Set([
  'user_not_found', 'users_not_found', 'cannot_dm_bot', 'user_disabled', 'channel_not_found',
  'is_archived', 'msg_too_long', 'no_text', 'invalid_blocks', 'restricted_action',
  'not_in_channel', 'user_is_restricted', 'user_is_ultra_restricted', 'method_not_supported_for_channel_type',
]);

export type SlackErrorKind = 'auth' | 'permanent' | 'retry';

export function classifySlackError(code: string | undefined): SlackErrorKind {
  if (code && AUTH_ERRORS.has(code)) return 'auth';
  if (code && PERMANENT_ERRORS.has(code)) return 'permanent';
  return 'retry';
}

/** Replace each exact '{{token}}' with its value in one pass, as SendGrid does. */
export function renderSlackText(template: string, substitutions: Record<string, string>): string {
  const keys = Object.keys(substitutions);
  if (!template || keys.length === 0) return template;
  const re = new RegExp(keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return template.replace(re, (m) => substitutions[m] ?? '');
}

interface SlackResponse { ok: boolean; error?: string; retryAfterMs?: number; channel?: { id?: string }; ts?: string }

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function slackCall(fetchImpl: FetchLike | undefined, method: string, token: string, params: Record<string, string>): Promise<SlackResponse> {
  let res: Response;
  try {
    res = await (fetchImpl ?? globalThis.fetch)(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, error: 'network_error' };
  }
  if (res.status === 429) {
    const seconds = Number(res.headers.get('retry-after'));
    return { ok: false, error: 'ratelimited', retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000 };
  }
  try {
    const json = (await res.json()) as SlackResponse;
    return json && typeof json === 'object' ? json : { ok: false, error: 'bad_response' };
  } catch {
    return { ok: false, error: `http_${res.status}` };
  }
}

function failure(stage: string, r: SlackResponse): BatchedResult {
  const code = r.error || `${stage}_failed`;
  const kind = classifySlackError(code);
  const error = `Slack ${stage}: ${code}`;
  if (kind === 'auth') return { success: false, retryable: true, error, haltSend: `The Slack token was refused (${code}). Check the Slack connection and its scopes, then resume the send.` };
  if (kind === 'permanent') return { success: false, retryable: false, error };
  return { success: false, retryable: true, error, retryAfterMs: r.retryAfterMs };
}

// fetch is looked up per call (not captured at load) so tests can stub it.
export function makeSlackChannelProvider(fetchImpl?: FetchLike): ChannelProvider {
  return {
    channel: 'slack',
    providerName: 'slack',
    maxPerCall: 1,
    writesSendLog: false,
    resolveAddress(r: Recipient): string | null {
      const id = (r.slack_user_id ?? '').trim();
      return SLACK_USER_ID.test(id) ? id : null;
    },
    async sendBatch(msg: BatchedMessage): Promise<BatchedResult> {
      const token = msg.auth?.token;
      if (!token) {
        return { success: false, retryable: true, error: 'No Slack token', haltSend: 'No Slack token is available for this sender. Connect Slack, then resume the send.' };
      }
      if (msg.personalizations.length === 0) return { success: false, retryable: false, error: 'Recipient has no Slack user ID' };
      if (msg.personalizations.length > 1) return { success: false, retryable: false, error: 'Slack sends one message per call' };
      const p = msg.personalizations[0];
      const text = renderSlackText(msg.bodyText ?? '', p.substitutions).trim();
      if (!text) return { success: false, retryable: true, error: 'Empty message', haltSend: 'The Slack message is empty. Add the message text, then resume the send.' };
      if (text.length > MAX_SLACK_MESSAGE_CHARS) return { success: false, retryable: false, error: `Message is ${text.length} characters; Slack's limit is ${MAX_SLACK_MESSAGE_CHARS}` };

      const open = await slackCall(fetchImpl, 'conversations.open', token, { users: p.to });
      const channel = open.channel?.id;
      if (!open.ok || !channel) return failure('conversations.open', open.ok ? { ok: false, error: 'no_channel' } : open);

      const post = await slackCall(fetchImpl, 'chat.postMessage', token, {
        channel, text, unfurl_links: 'true', unfurl_media: 'false',
      });
      if (!post.ok) return failure('chat.postMessage', post);
      return { success: true, batchMessageId: `${channel}:${post.ts ?? ''}` };
    },
  };
}

export const slackChannelProvider: ChannelProvider = makeSlackChannelProvider();
