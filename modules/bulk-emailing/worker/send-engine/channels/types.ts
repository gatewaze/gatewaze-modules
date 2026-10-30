/**
 * Channel abstraction for the Central Sending Service (Phase 4 — the
 * ChannelProvider seam, spec-central-sending-service.md §Channel abstraction).
 *
 * Two orthogonal axes: *domain* (newsletter/broadcast/bulk — what produces the
 * send, owned by a SendEngineBinding) and *channel* (email/sms/whatsapp/in_app —
 * how it's delivered, owned by a ChannelProvider). Everything between —
 * scheduling, fanout, the recipients queue, per-recipient-timezone send_at, the
 * claim_due drip, pause/resume/cancel, recovery, the quota mechanism — is
 * channel-agnostic and reused unchanged. Only the four members below vary by
 * channel.
 *
 * Email (SendGrid) is the sole verified implementation; the Twilio SMS +
 * WhatsApp providers are real but inert without TWILIO_* credentials.
 */
import type { Recipient } from '../engine.js';

// A file delivered alongside the message. SendGrid carries attachments at the
// MESSAGE level, not per-personalization — so a message with attachments can
// only address the recipients those attachments belong to. The engine handles
// that by dropping to one personalization per call when a send declares
// per-recipient attachments (SendContext.perRecipientAttachments).
export interface MessageAttachment {
  filename: string;
  content: string;             // base64
  type?: string;               // MIME; defaults to application/octet-stream
  disposition?: 'attachment' | 'inline';
  contentId?: string;          // for disposition: 'inline'
}

// Generalised from Tier 2's SendGrid message: html for email, bodyText for
// sms/whatsapp. The engine fills exactly one per the send's channel.
export interface BatchedMessage {
  from: string; fromName?: string; replyTo?: string;
  subject: string; html?: string; bodyText?: string;
  disableSubscriptionTracking?: boolean;
  // Message-level; see MessageAttachment. Only meaningful for email.
  attachments?: MessageAttachment[];
  // Credentials a channel reads per send rather than from env (Slack's token
  // lives in the slack module's sealed config). Filled from SendContext.channelAuth.
  auth?: { token: string };
  personalizations: Array<{
    to: string;
    headers?: Record<string, string>;
    substitutions: Record<string, string>;            // '{{token}}' -> value
    customArgs?: Record<string, string>;              // { <domain>_send_id, recipient_log_id }
  }>;
}

export interface BatchedResult {
  success: boolean;
  batchMessageId?: string;
  error?: string;
  statusCode?: number;
  retryable?: boolean;
  rejectedIndices?: number[];
  // Every later message of this send would fail the same way (e.g. a revoked
  // token). The engine puts the batch back and pauses the send with this reason.
  haltSend?: string;
  // The provider asked us to back off. The engine stops the tick and leaves
  // the rest for the next one.
  retryAfterMs?: number;
}

// Tier 2 NormalizedEmailEvent, generalised across channels — what a channel's
// webhook parser yields for the engagement/reputation pipeline.
export interface NormalizedEvent {
  providerMessageId: string;
  recipientAddress?: string;
  channel: string;
  eventType: 'delivered' | 'bounced' | 'dropped' | 'failed' | 'spam_reported' | 'open' | 'click';
  timestamp: Date;
  clickedUrl?: string;
  bounceReason?: string;
}

export interface ChannelProvider {
  channel: 'email' | 'sms' | 'whatsapp' | 'in_app' | 'slack';
  // Recorded on email_send_log.provider so webhook attribution + reporting know
  // which provider handled the send.
  providerName: string;
  // Most recipients one sendBatch call may carry. Unset = the engine's batchSize.
  maxPerCall?: number;
  // false = no email_send_log rows (and so no reputation gate) for this
  // channel; the recipient row and its batch row are the record. Default true.
  writesSendLog?: boolean;
  // Per-recipient destination from the person: email vs E.164 phone vs handle.
  resolveAddress(r: Recipient): string | null;
  // Batched dispatch (email → SendGrid sendBatch; sms/whatsapp → Twilio).
  // Providers that can't carry attachments simply ignore msg.attachments; the
  // engine only populates it for channels whose binding builds them.
  sendBatch(msg: BatchedMessage): Promise<BatchedResult>;
  // Crash recovery: was the batch accepted by the provider? Email only (the
  // engine treats absence as "unknown → leave for next tick / release after TTL").
  queryBatchAccepted?(providerBatchId: string, postedAt: Date): Promise<{ accepted: boolean; notSeen: boolean }>;
  // Channel-specific webhook → normalised events (delivery/failure). Wired per
  // channel in a follow-on; defined here so the seam is complete.
  parseWebhookPayload?(req: Request): Promise<NormalizedEvent[] | null>;
}
