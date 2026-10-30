/**
 * Slack broadcast binding for the shared send engine. Same tables as the email
 * binding (broadcast_sends / broadcast_send_recipients / broadcast_send_batches)
 * but its own claim, so Slack recipients drip on the paced Slack job
 * (workers/dispatch-slack.ts) and never share an email claim.
 *
 * The message is the send's body_text, Slack mrkdwn, with merge fields filled
 * per recipient (lib/slack-message.ts). There is no unsubscribe link: a Slack
 * send is not tied to an email list.
 *
 * The token is read on every tick: the workspace bot (slack module's sealed
 * SLACK_BOT_TOKEN) or the account connected for welcome DMs, per the send's
 * metadata.slack_sender. It lives only in the tick's SendContext.
 */
import type { EngineDeps, SendContext, SendEngineBinding, Recipient } from '../../bulk-emailing/worker/send-engine/engine.js';
import { readSlackToken, scanTokens, slackSenderOf, slackSubstitutions } from '../lib/slack-message.js';

type SlackCtx = SendContext & {
  tokens: string[];
  attrs: Map<string, Record<string, unknown>>;   // person_id -> attributes
};

export const broadcastSlackBinding: SendEngineBinding = {
  domain: 'broadcast',
  sendsTable: 'broadcast_sends',
  recipientsTable: 'broadcast_send_recipients',
  batchesTable: 'broadcast_send_batches',
  logSendIdColumn: 'broadcast_send_id',
  claimRpc: 'claim_due_broadcast_slack_recipients',

  async buildSendContext(deps: EngineDeps, sendId: string): Promise<SendContext | null> {
    const { data: send } = await deps.supabase.from('broadcast_sends').select('*').eq('id', sendId).single();
    if (!send || send.channel !== 'slack') return null;
    let token: string;
    try {
      token = await readSlackToken(deps.supabase, slackSenderOf(send.metadata));
    } catch (e) {
      // Could not read the config (database blip): hold the rows for the next
      // tick rather than pause the send over a transient error.
      deps.logger.warn('[send-engine] could not read the Slack token; holding', { sendId, err: e instanceof Error ? e.message : String(e) });
      return null;
    }
    const text: string = send.body_text ?? '';
    const ctx: SlackCtx = {
      sendId,
      brand: send.brand || process.env.SEND_ENGINE_DEFAULT_BRAND || 'default',
      channel: 'slack',
      subject: send.subject || send.name || 'Slack message',
      html: '',
      bodyText: text,
      fromEmail: '',
      fromName: send.from_name || '',
      replyTo: null,
      // An empty token reaches the provider, which pauses the send and says why.
      channelAuth: { token },
      tokens: scanTokens(text),
      attrs: new Map(),
    };
    return ctx;
  },

  async prepareBatch(deps: EngineDeps, ctx: SendContext, recipients: Recipient[]): Promise<void> {
    const c = ctx as SlackCtx;
    if (!c.tokens.length) return;
    const ids = [...new Set(recipients.map((r) => r.person_id).filter((v): v is string => !!v && !c.attrs.has(v)))];
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await deps.supabase.from('people').select('id, attributes').in('id', ids.slice(i, i + 200));
      for (const row of data ?? []) c.attrs.set(row.id, row.attributes ?? {});
    }
  },

  async buildSubstitutions(ctx: SendContext, r: Recipient): Promise<Record<string, string>> {
    const c = ctx as SlackCtx;
    const attrs = (r.person_id && c.attrs.get(r.person_id)) || {};
    return slackSubstitutions(c.tokens, attrs, r.email);
  },

  async onSendHalted(deps: EngineDeps, sendId: string, reason: string): Promise<void> {
    const { data: send } = await deps.supabase.from('broadcast_sends').select('metadata').eq('id', sendId).single();
    const metadata = { ...((send?.metadata as Record<string, unknown> | null) ?? {}), paused_reason: reason, paused_at: new Date().toISOString() };
    await deps.supabase.from('broadcast_sends').update({ metadata }).eq('id', sendId);
  },
};
