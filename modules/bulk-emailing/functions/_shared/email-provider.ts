/**
 * Email Provider Interface
 *
 * Defines the contract that email provider sub-modules must implement.
 * The bulk-emailing module is provider-agnostic — all sending goes through
 * this interface, and webhook events are normalized before processing.
 */

export interface SendEmailParams {
  to: string;
  from: string;
  fromName?: string;
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  cc?: string;
  /** Custom headers (e.g., List-Unsubscribe) */
  headers?: Record<string, string>;
  /** Provider-specific tags/categories for analytics */
  tags?: Record<string, string>;
  /**
   * When true, ask the provider NOT to append its own unsubscribe footer/link
   * (e.g. SendGrid Subscription Tracking). Use when the caller supplies its own
   * unsubscribe link + List-Unsubscribe header. Default (undefined) leaves the
   * provider's account-level behaviour unchanged.
   */
  disableSubscriptionTracking?: boolean;
}

export interface SendEmailResult {
  success: boolean;
  /** Provider's message ID — stored in email_send_log.provider_message_id for webhook matching */
  messageId?: string;
  error?: string;
  /** HTTP status code from the provider API */
  statusCode?: number;
  /** true for transient failures (429, 5xx) that should be retried */
  retryable: boolean;
}

/**
 * Normalized email event — the common format that all provider webhook
 * payloads are converted into before the core module processes them.
 */
export interface NormalizedEmailEvent {
  messageId: string;
  /**
   * Recipient email on the event, when the provider exposes one.
   * Used by email-webhook to disambiguate batch-send rows where one
   * messageId covers multiple recipients — without it, a duplicate
   * provider_message_id row silently drops the event. SendGrid always
   * includes `email`; providers that don't can omit this and the
   * webhook falls back to messageId-only lookup.
   */
  recipientEmail?: string;
  eventType: 'delivered' | 'bounced' | 'dropped' | 'spam_reported' | 'open' | 'click';
  timestamp: Date;
  userAgent?: string;
  ip?: string;
  clickedUrl?: string;
  bounceType?: string;
  bounceReason?: string;
}

/**
 * The contract that email provider sub-modules must implement.
 * Each provider is a separate Gatewaze module (e.g., email-provider-sendgrid).
 */
export interface EmailProviderModule {
  /** Provider identifier (e.g., 'sendgrid', 'ses') */
  name: string;

  /** Send a single email */
  send(params: SendEmailParams): Promise<SendEmailResult>;

  /**
   * Parse a raw webhook payload into normalized events.
   * Returns null if the payload doesn't belong to this provider.
   */
  parseWebhookPayload(request: Request): Promise<NormalizedEmailEvent[] | null>;

  /**
   * Verify webhook authenticity (signature validation).
   * Returns true if the webhook is from the legitimate provider.
   */
  verifyWebhook(request: Request): Promise<boolean>;

  /** Environment variable names required by this provider */
  requiredEnvVars(): string[];
}
