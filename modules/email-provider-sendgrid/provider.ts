import type {
  EmailProviderModule,
  SendEmailParams,
  SendEmailResult,
  NormalizedEmailEvent,
} from '../_shared/email-provider.ts';

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';

type SendGridEventType =
  | 'processed' | 'deferred' | 'delivered'
  | 'open' | 'click'
  | 'bounce' | 'dropped'
  | 'spamreport' | 'unsubscribe'
  | 'group_unsubscribe' | 'group_resubscribe';

function mapSendGridEvent(
  sgEvent: string
): NormalizedEmailEvent['eventType'] | null {
  switch (sgEvent) {
    case 'delivered': return 'delivered';
    case 'bounce': return 'bounced';
    case 'dropped': return 'dropped';
    case 'spamreport': return 'spam_reported';
    case 'open': return 'open';
    case 'click': return 'click';
    default: return null;
  }
}

/**
 * Extract the base message ID from SendGrid's various formats.
 * SendGrid may send the ID as:
 *   - "abc123.filter0001.12345.abc123-1"
 *   - "<abc123@domain>"
 * We normalize to the base ID for matching against email_send_log.
 */
function extractMessageId(raw: string | undefined): string {
  if (!raw) return '';
  let id = raw.replace(/^<|>$/g, ''); // Strip angle brackets
  const dotIdx = id.indexOf('.');
  if (dotIdx > 0) id = id.substring(0, dotIdx);
  return id;
}

const provider: EmailProviderModule = {
  name: 'sendgrid',

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    const apiKey = Deno.env.get('SENDGRID_API_KEY');
    if (!apiKey) {
      return {
        success: false,
        error: 'SENDGRID_API_KEY not configured',
        retryable: false,
      };
    }

    const body: Record<string, unknown> = {
      personalizations: [{
        to: [{ email: params.to }],
        ...(params.cc ? { cc: [{ email: params.cc }] } : {}),
      }],
      from: { email: params.from, ...(params.fromName ? { name: params.fromName } : {}) },
      subject: params.subject,
      content: [
        ...(params.text ? [{ type: 'text/plain', value: params.text }] : []),
        { type: 'text/html', value: params.html },
      ],
    };

    if (params.replyTo) {
      body.reply_to = { email: params.replyTo };
    }
    if (params.headers) {
      body.headers = params.headers;
    }
    if (params.tags) {
      body.categories = Object.values(params.tags);
    }
    if (params.disableSubscriptionTracking) {
      // Suppress SendGrid's account-level Subscription Tracking footer so it
      // doesn't append its own unsubscribe link — the caller provides one.
      body.tracking_settings = { subscription_tracking: { enable: false } };
    }

    try {
      const response = await fetch(SENDGRID_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const statusCode = response.status;
        const errorText = await response.text();
        return {
          success: false,
          error: `SendGrid ${statusCode}: ${errorText}`,
          statusCode,
          retryable: statusCode === 429 || statusCode >= 500,
        };
      }

      return {
        success: true,
        messageId: response.headers.get('x-message-id') || undefined,
        retryable: false,
      };
    } catch (err) {
      return {
        success: false,
        error: `SendGrid network error: ${(err as Error).message}`,
        retryable: true,
      };
    }
  },

  async parseWebhookPayload(request: Request): Promise<NormalizedEmailEvent[] | null> {
    let events: unknown[];
    try {
      const body = await request.clone().json();
      if (!Array.isArray(body)) return null;
      events = body;
    } catch {
      return null;
    }

    const normalized: NormalizedEmailEvent[] = [];

    for (const event of events) {
      const e = event as Record<string, unknown>;
      const eventType = mapSendGridEvent(e.event as string);
      if (!eventType) continue;

      const rawMsgId = (e.sg_message_id || e['smtp-id']) as string | undefined;
      const messageId = extractMessageId(rawMsgId);
      if (!messageId) continue;

      normalized.push({
        messageId,
        eventType,
        timestamp: new Date((e.timestamp as number) * 1000),
        userAgent: (e.useragent as string) || undefined,
        ip: (e.ip as string) || undefined,
        clickedUrl: (e.url as string) || undefined,
        bounceType: (e.type as string) || undefined,
        bounceReason: (e.reason as string) || undefined,
      });
    }

    return normalized;
  },

  async verifyWebhook(request: Request): Promise<boolean> {
    // SendGrid signed event webhook verification
    // Uses the public key from SendGrid's event webhook settings
    const publicKey = Deno.env.get('SENDGRID_WEBHOOK_VERIFICATION_KEY');
    if (!publicKey) {
      // If no verification key is configured, allow through
      // (user should configure this for production)
      console.warn('[sendgrid-provider] No SENDGRID_WEBHOOK_VERIFICATION_KEY configured, skipping verification');
      return true;
    }

    const signature = request.headers.get('X-Twilio-Email-Event-Webhook-Signature');
    const timestamp = request.headers.get('X-Twilio-Email-Event-Webhook-Timestamp');

    if (!signature || !timestamp) return false;

    try {
      const body = await request.clone().text();
      const payload = timestamp + body;

      // Import the public key and verify ECDSA signature
      const keyData = Uint8Array.from(atob(publicKey), c => c.charCodeAt(0));
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      );

      const sigData = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
      const payloadData = new TextEncoder().encode(payload);

      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        cryptoKey,
        sigData,
        payloadData
      );
    } catch (err) {
      console.error('[sendgrid-provider] Webhook verification failed:', err);
      return false;
    }
  },

  requiredEnvVars() {
    return ['SENDGRID_API_KEY'];
  },
};

export default provider;
