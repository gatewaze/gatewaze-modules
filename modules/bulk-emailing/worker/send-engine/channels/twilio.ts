/**
 * Twilio SMS + WhatsApp ChannelProviders (Phase 4). Real implementations
 * against the Twilio REST API, but INERT without TWILIO_ACCOUNT_SID /
 * TWILIO_AUTH_TOKEN / a per-channel From — they return a non-retryable
 * "not configured" result so the engine marks the batch failed rather than
 * looping. Adding SMS/WhatsApp delivery is then: set the env + populate channel
 * consent + a status-callback webhook route.
 *
 * UNVERIFIED end-to-end (no Twilio account / real handset in dev). The shape
 * follows the ChannelProvider seam so it is a drop-in once configured.
 *
 * Twilio has no native multi-recipient batch — sendBatch loops Messages.create
 * (one POST per personalization), rendering bodyText per recipient from its
 * substitution map. Twilio returns one SID per message; the engine's all-or-
 * nothing batch model treats the batch as accepted only if every message was
 * accepted (HTTP 201 → status 'queued'/'accepted'), else aggregates the failure.
 */
import type { Recipient } from '../engine.js';
import type { ChannelProvider, BatchedMessage, BatchedResult, NormalizedEvent } from './types.js';

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

function renderBody(template: string, substitutions: Record<string, string>): string {
  let out = template;
  for (const [token, value] of Object.entries(substitutions)) {
    out = out.split(token).join(value);   // tokens are exact '{{...}}' strings
  }
  return out;
}

interface TwilioConfig { accountSid: string; authToken: string; from: string }

function readConfig(fromEnvKey: string): TwilioConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env[fromEnvKey];
  if (!accountSid || !authToken || !from) return null;
  return { accountSid, authToken, from };
}

async function twilioCreateMessage(cfg: TwilioConfig, to: string, body: string, statusCallback?: string): Promise<{ ok: boolean; sid?: string; status?: number; error?: string; retryable?: boolean }> {
  const form = new URLSearchParams({ To: to, Body: body });
  // From may be an E.164 number or a Messaging Service SID (MG...).
  if (cfg.from.startsWith('MG')) form.set('MessagingServiceSid', cfg.from);
  else form.set('From', cfg.from);
  if (statusCallback) form.set('StatusCallback', statusCallback);
  try {
    const res = await fetch(`${TWILIO_BASE}/Accounts/${cfg.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    if (res.status === 201) {
      const json = (await res.json().catch(() => ({}))) as { sid?: string };
      return { ok: true, sid: json.sid };
    }
    const txt = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: `Twilio ${res.status}: ${txt}`.slice(0, 300), retryable: res.status === 429 || res.status >= 500 };
  } catch (err) {
    return { ok: false, error: `Twilio network error: ${(err as Error).message}`, retryable: true };
  }
}

function makeTwilioProvider(channel: 'sms' | 'whatsapp', fromEnvKey: string): ChannelProvider {
  const isWhatsApp = channel === 'whatsapp';
  return {
    channel,
    providerName: channel === 'whatsapp' ? 'twilio-whatsapp' : 'twilio-sms',
    resolveAddress(r: Recipient): string | null {
      const phone = (r.phone ?? '').trim();
      if (!phone) return null;
      return isWhatsApp ? `whatsapp:${phone}` : phone;
    },
    async sendBatch(msg: BatchedMessage): Promise<BatchedResult> {
      const cfg = readConfig(fromEnvKey);
      if (!cfg) return { success: false, error: `${fromEnvKey}/TWILIO_ACCOUNT_SID not configured`, retryable: false };
      const template = msg.bodyText ?? '';
      if (!template) return { success: false, error: 'No bodyText for SMS/WhatsApp send', retryable: false };
      const statusCallback = process.env.TWILIO_STATUS_CALLBACK_URL || undefined;
      const rejectedIndices: number[] = [];
      let firstSid: string | undefined;
      let anyRetryable = false;
      let lastError: string | undefined;
      for (let i = 0; i < msg.personalizations.length; i++) {
        const p = msg.personalizations[i];
        const to = isWhatsApp && !p.to.startsWith('whatsapp:') ? `whatsapp:${p.to}` : p.to;
        const body = renderBody(template, p.substitutions);
        const r = await twilioCreateMessage(cfg, to, body, statusCallback);
        if (r.ok) { firstSid ??= r.sid; }
        else { rejectedIndices.push(i); anyRetryable = anyRetryable || !!r.retryable; lastError = r.error; }
      }
      if (rejectedIndices.length === 0) return { success: true, batchMessageId: firstSid };
      // Partial/total failure: surface for the engine's all-or-nothing handling.
      return { success: false, error: lastError, retryable: anyRetryable, rejectedIndices };
    },
    // Twilio status callbacks are form-encoded (MessageSid, MessageStatus, To).
    async parseWebhookPayload(req: Request): Promise<NormalizedEvent[] | null> {
      try {
        const form = await req.formData();
        const sid = String(form.get('MessageSid') || form.get('SmsSid') || '');
        const status = String(form.get('MessageStatus') || form.get('SmsStatus') || '');
        const to = String(form.get('To') || '');
        if (!sid || !status) return null;
        const map: Record<string, NormalizedEvent['eventType']> = {
          delivered: 'delivered', sent: 'delivered',
          undelivered: 'failed', failed: 'failed',
        };
        const eventType = map[status];
        if (!eventType) return [];                        // queued/sending/etc. — ignore
        return [{ providerMessageId: sid, recipientAddress: to.replace(/^whatsapp:/, ''), channel, eventType, timestamp: new Date() }];
      } catch {
        return null;
      }
    },
  };
}

export const twilioSmsChannelProvider: ChannelProvider = makeTwilioProvider('sms', 'TWILIO_SMS_FROM');
export const whatsappChannelProvider: ChannelProvider = makeTwilioProvider('whatsapp', 'TWILIO_WHATSAPP_FROM');
