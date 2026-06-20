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

// Generalised from Tier 2's SendGrid message: html for email, bodyText for
// sms/whatsapp. The engine fills exactly one per the send's channel.
export interface BatchedMessage {
  from: string; fromName?: string; replyTo?: string;
  subject: string; html?: string; bodyText?: string;
  disableSubscriptionTracking?: boolean;
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
  channel: 'email' | 'sms' | 'whatsapp' | 'in_app';
  // Recorded on email_send_log.provider so webhook attribution + reporting know
  // which provider handled the send.
  providerName: string;
  // Per-recipient destination from the person: email vs E.164 phone vs handle.
  resolveAddress(r: Recipient): string | null;
  // Batched dispatch (email → SendGrid sendBatch; sms/whatsapp → Twilio).
  sendBatch(msg: BatchedMessage): Promise<BatchedResult>;
  // Crash recovery: was the batch accepted by the provider? Email only (the
  // engine treats absence as "unknown → leave for next tick / release after TTL").
  queryBatchAccepted?(providerBatchId: string, postedAt: Date): Promise<{ accepted: boolean; notSeen: boolean }>;
  // Channel-specific webhook → normalised events (delivery/failure). Wired per
  // channel in a follow-on; defined here so the seam is complete.
  parseWebhookPayload?(req: Request): Promise<NormalizedEvent[] | null>;
}
