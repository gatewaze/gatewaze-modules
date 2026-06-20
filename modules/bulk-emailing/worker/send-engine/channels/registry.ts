/**
 * Channel provider registry. The engine selects a ChannelProvider by the send's
 * `channel` (newsletter_sends.channel / broadcast_sends.channel /
 * email_batch_jobs.channel — all default 'email'). Unknown/in_app falls back to
 * email so a misconfigured channel never silently drops a send.
 */
import { emailChannelProvider } from './email.js';
import { twilioSmsChannelProvider, whatsappChannelProvider } from './twilio.js';
import type { ChannelProvider } from './types.js';

const REGISTRY: Record<string, ChannelProvider> = {
  email: emailChannelProvider,
  sms: twilioSmsChannelProvider,
  whatsapp: whatsappChannelProvider,
};

export function resolveChannelProvider(channel: string | null | undefined): ChannelProvider {
  return REGISTRY[channel ?? 'email'] ?? emailChannelProvider;
}
