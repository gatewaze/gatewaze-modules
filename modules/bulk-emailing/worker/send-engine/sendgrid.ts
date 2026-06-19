/**
 * Node-side SendGrid batched send for the worker drip engine.
 *
 * The Deno edge provider (email-provider-sendgrid/provider.ts) can't run in the
 * Node worker (it uses Deno.env), so the worker calls SendGrid directly here via
 * global fetch + process.env. This deliberately duplicates ~the provider's
 * sendBatch body-building (resolution (1) in spec-central-sending-service.md);
 * making the provider runtime-agnostic to drop this duplication is a follow-up.
 */
const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';

export interface NodeBatchedMessage {
  from: string; fromName?: string; replyTo?: string; subject: string; html: string;
  disableSubscriptionTracking?: boolean;
  personalizations: Array<{ to: string; headers?: Record<string, string>; substitutions: Record<string, string>; customArgs?: Record<string, string>; }>;
}
export interface NodeBatchedResult { success: boolean; batchMessageId?: string; error?: string; statusCode?: number; retryable?: boolean; }

export async function sendBatchViaSendgrid(message: NodeBatchedMessage): Promise<NodeBatchedResult> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return { success: false, error: 'SENDGRID_API_KEY not configured', retryable: false };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: Record<string, any> = {
    from: { email: message.from, ...(message.fromName ? { name: message.fromName } : {}) },
    subject: message.subject,
    content: [{ type: 'text/html', value: message.html }],
    personalizations: message.personalizations.map((p) => ({
      to: [{ email: p.to }],
      ...(p.headers ? { headers: p.headers } : {}),
      ...(p.substitutions ? { substitutions: p.substitutions } : {}),
      ...(p.customArgs ? { custom_args: p.customArgs } : {}),
    })),
  };
  if (message.replyTo) body.reply_to = { email: message.replyTo };
  if (message.disableSubscriptionTracking) body.tracking_settings = { subscription_tracking: { enable: false } };

  try {
    const res = await fetch(SENDGRID_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const statusCode = res.status;
      const errorText = await res.text().catch(() => '');
      return { success: false, error: `SendGrid ${statusCode}: ${errorText}`, statusCode, retryable: statusCode === 429 || statusCode >= 500 };
    }
    return { success: true, batchMessageId: res.headers.get('x-message-id') || undefined };
  } catch (err) {
    return { success: false, error: `SendGrid network error: ${(err as Error).message}`, retryable: true };
  }
}

// Crash recovery: did SendGrid accept the batch? Email Activity API; unknown on
// failure (so the engine LEAVES the batch rather than risk a double-send).
export async function queryBatchAccepted(providerBatchId: string, _postedAt: Date): Promise<{ accepted: boolean; notSeen: boolean }> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey || !providerBatchId) return { accepted: false, notSeen: false };
  const prefix = providerBatchId.split('.')[0];
  const url = `https://api.sendgrid.com/v3/messages?query=${encodeURIComponent(`msg_id LIKE "${prefix}%"`)}&limit=1`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return { accepted: false, notSeen: false };
    const json = (await res.json()) as { messages?: unknown[] };
    return (json.messages?.length ?? 0) > 0 ? { accepted: true, notSeen: false } : { accepted: false, notSeen: true };
  } catch {
    return { accepted: false, notSeen: false };
  }
}
