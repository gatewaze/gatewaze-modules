/**
 * Slack broadcast message helpers, shared by the Slack send binding and the
 * Slack admin routes: which token to send with, and per-recipient merge
 * fields escaped for Slack.
 *
 * Merge fields come from people's profiles, so they are escaped: a value like
 * `<!channel>` is shown as text rather than notifying anyone. The message
 * template is the admin's own text and is sent as written, so it can use
 * Slack formatting on purpose.
 */
import { encodeEmail, unquote } from './merge-values.js';

export type SlackSender = 'bot' | 'welcome_sender';

const MERGE_FIELDS = ['first_name', 'last_name', 'name', 'company', 'job_title'];

export interface SlackStore {
  readSlackConfig(sb: unknown): Promise<{ botToken: string }>;
  readSenderWithToken(sb: unknown): Promise<{ token: string | null } | null>;
  readSender(sb: unknown): Promise<{ slack_user_name?: string | null; status?: string | null } | null>;
}

// The slack module's lib is plain JS with no types, so it is loaded by a path
// TypeScript does not resolve. Under tsx/CJS the exports can arrive nested
// under .default (see workers/dispatch-scheduled.ts). Overridable for tests.
let loadStore = async (): Promise<SlackStore> => {
  const mod = (await import('../../slack/lib/welcome-store.js' as string)) as SlackStore & { default?: SlackStore };
  return typeof mod.readSlackConfig === 'function' ? mod : (mod.default as SlackStore);
};
export function setSlackStoreLoader(fn: () => Promise<SlackStore>): void { loadStore = fn; }

/** The token to send with, or '' when that sender is not set up. Throws if it could not be read. */
export async function readSlackToken(sb: unknown, sender: SlackSender): Promise<string> {
  const store = await loadStore();
  if (sender === 'welcome_sender') return (await store.readSenderWithToken(sb))?.token ?? '';
  return (await store.readSlackConfig(sb)).botToken ?? '';
}

/** The account connected for welcome DMs, without its token. */
export async function readWelcomeSender(sb: unknown): Promise<{ slack_user_name?: string | null; status?: string | null } | null> {
  return (await loadStore()).readSender(sb);
}

export function slackSenderOf(metadata: unknown): SlackSender {
  return (metadata as { slack_sender?: unknown } | null)?.slack_sender === 'welcome_sender' ? 'welcome_sender' : 'bot';
}

/** Slack's three control characters in message text. */
export function escapeSlackText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function scanTokens(text: string): string[] {
  return [...new Set(text.match(/\{\{[^}]+\}\}/g) ?? [])];
}

/** Per-recipient substitutions for a Slack message. Unknown tokens are left as written. */
export function slackSubstitutions(tokens: string[], attrs: Record<string, unknown>, email: string | null): Record<string, string> {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
  const subs: Record<string, string> = {};
  for (const token of tokens) {
    const inner = token.slice(2, -2).trim();
    if (inner === 'unsubscribe_url' || inner === 'manage_subscriptions_url') { subs[token] = ''; continue; }
    if (inner === 'email_encoded') { subs[token] = email ? encodeEmail(email) : ''; continue; }
    const m = inner.match(/^([a-z_]+)\s*(?:\|(.*))?$/);
    if (m && MERGE_FIELDS.includes(m[1])) {
      let val = m[1] === 'name'
        ? [str(attrs.first_name), str(attrs.last_name)].filter(Boolean).join(' ')
        : str(attrs[m[1]]);
      if (!val && m[2] !== undefined) val = unquote(m[2]);
      subs[token] = escapeSlackText(val);
    }
  }
  return subs;
}
