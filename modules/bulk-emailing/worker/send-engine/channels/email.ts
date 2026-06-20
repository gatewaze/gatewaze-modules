/**
 * Email ChannelProvider — the sole verified channel. Wraps the existing Tier 2
 * Node-side SendGrid sendBatch + crash-recovery query (../sendgrid.ts), so the
 * email path through the seam is byte-identical to before Phase 4.
 */
import { sendBatchViaSendgrid, queryBatchAccepted } from '../sendgrid.js';
import type { Recipient } from '../engine.js';
import type { ChannelProvider, BatchedMessage, BatchedResult } from './types.js';

export const emailChannelProvider: ChannelProvider = {
  channel: 'email',
  providerName: 'sendgrid',
  resolveAddress: (r: Recipient) => r.email ?? null,
  sendBatch: (msg: BatchedMessage): Promise<BatchedResult> =>
    sendBatchViaSendgrid({
      from: msg.from,
      fromName: msg.fromName,
      replyTo: msg.replyTo,
      subject: msg.subject,
      html: msg.html ?? '',
      disableSubscriptionTracking: msg.disableSubscriptionTracking,
      personalizations: msg.personalizations.map((p) => ({
        to: p.to,
        headers: p.headers,
        substitutions: p.substitutions,
        customArgs: p.customArgs,
      })),
    }),
  queryBatchAccepted: (providerBatchId: string, postedAt: Date) => queryBatchAccepted(providerBatchId, postedAt),
};
