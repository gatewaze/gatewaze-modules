import { useMemo, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { SendingPanel } from '@/components/sending';
import type { SendingAdapter, SendComposerConfig } from '@/components/sending';
import { getViewOnlineUrl } from '../utils/view-online-url';

interface CollectionInfo {
  id?: string;
  from_email?: string | null;
  from_name?: string | null;
  reply_to?: string | null;
  list_id?: string | null;
  list_name?: string | null;
  subscriber_count?: number;
  view_online_target?: string | null;
  view_online_external_base_url?: string | null;
}

interface EditionSendingTabProps {
  editionId: string;
  editionDate?: string;
  subject: string;
  collection: CollectionInfo | null;
  newsletterSlug?: string;
  editionStatus?: string;
  /** Async renderer producing the final email-safe HTML for the edition. */
  getRenderedHtml?: () => Promise<string>;
}

/**
 * Newsletter sending tab — now a thin adapter over the shared <SendingPanel>
 * (packages/admin/src/components/sending). The newsletter specifics (edition
 * render + View Online, the per-edition send row, the test-send route) live in
 * the adapter; the panel owns the composer, scheduling, realtime log, history,
 * and lifecycle actions — shared with broadcasts + event comms.
 *
 * Newsletter email-details (From / reply-to) are NOT editable here — they're
 * newsletter-level (collection), shown read-only with an Edit link to the
 * newsletter settings. The editor keeps its own test send; this adds one too.
 */
export function EditionSendingTab({ editionId, editionDate, subject, collection, newsletterSlug, editionStatus, getRenderedHtml }: EditionSendingTabProps) {
  // Render the edition to final email HTML with the web-version link substituted
  // (shared by createSend + rerenderContent so both produce identical output).
  const buildFinalHtml = useCallback(async (): Promise<{ html: string | null; webVersionUrl: string; portalBaseUrl: string }> => {
    const portalProtocol = typeof window !== 'undefined' ? window.location.protocol : 'https:';
    const portalHost = typeof window !== 'undefined'
      ? window.location.hostname.replace('-admin.', '-app.').replace(/^admin\./, '')
      : 'localhost';
    const portalBaseUrl = `${portalProtocol}//${portalHost}`;
    const webVersionUrl = getViewOnlineUrl(
      { slug: newsletterSlug, view_online_target: collection?.view_online_target, view_online_external_base_url: collection?.view_online_external_base_url },
      { edition_date: editionDate, subject },
    ) ?? `${portalBaseUrl}/newsletters`;
    let html = getRenderedHtml ? await getRenderedHtml() : null;
    if (html) {
      html = html.replace(/\{\{web_version\}\}/g, webVersionUrl).replace(/\{%\s*view_in_browser_url\s*%\}/g, webVersionUrl);
    }
    return { html, webVersionUrl, portalBaseUrl };
  }, [newsletterSlug, collection?.view_online_target, collection?.view_online_external_base_url, editionDate, subject, getRenderedHtml]);

  const adapter: SendingAdapter = useMemo(() => {
    const settingsHref = newsletterSlug ? `/newsletters/${newsletterSlug}` : undefined;
    const isNew = editionId === 'new';
    return {
      domainKey: 'newsletter',
      title: 'Send Newsletter',
      parentId: isNew ? '' : editionId,
      sendsTable: 'newsletter_sends',
      parentFkColumn: 'edition_id',
      logSendIdColumn: 'newsletter_send_id',
      tzBreakdownRpc: 'newsletter_send_timezone_breakdown',
      sendEndpoint: 'newsletter-send',
      canSend: editionStatus === 'published',
      canSendReason: isNew
        ? 'Save the edition first'
        : editionStatus !== 'published'
          ? 'This edition is a draft. Publish it before sending — the email’s “View Online” link points at the published page.'
          : undefined,
      features: { deliveryStrategy: true, excludeSent: true },
      emailDetails: {
        editable: false,
        editHref: settingsHref,
        editLabel: 'Edit in settings',
        values: {
          subject: subject || '',
          preheader: '',
          fromAddress: collection?.from_email || '',
          fromName: collection?.from_name || '',
          replyTo: collection?.reply_to || '',
        },
      },
      recipients: {
        display: `${collection?.list_name || 'No list linked'}${collection?.subscriber_count != null ? ` (${collection.subscriber_count.toLocaleString()})` : ''}`,
        editable: true,
        editHref: settingsHref,
        editLabel: 'Edit',
      },
      recipientCount: collection?.subscriber_count ?? null,
      async countRecipients(excludeSentSendIds: string[]) {
        if (!collection?.list_id) return collection?.subscriber_count ?? 0;
        const { data, error } = await supabase.rpc('newsletter_recipient_preview_count', {
          p_list_id: collection.list_id,
          p_exclude_send_ids: excludeSentSendIds.length > 0 ? excludeSentSendIds : null,
        });
        if (error) throw error;
        return (data as number) ?? 0;
      },
      async createSend(config: SendComposerConfig) {
        const { html, webVersionUrl, portalBaseUrl } = await buildFinalHtml();
        const { data, error } = await supabase.from('newsletter_sends').insert({
          edition_id: editionId,
          // Without collection_id the worker engine can't look up the
          // collection's reply_to, so the outbound emails go without a
          // Reply-To header and every reply lands on the from-address
          // (demetrios@news.mlops.community) instead of the configured
          // reply-to (demetrios@aaif.live, which has the Inbound Parse
          // webhook). 06-24 mlopscommunity send shipped 50,493 emails
          // with reply_to=NULL before this fix.
          collection_id: collection?.id ?? null,
          status: config.scheduleType === 'scheduled' ? 'scheduled' : 'sending',
          subject: subject || null,
          from_address: collection?.from_email || null,
          from_name: collection?.from_name || null,
          list_ids: collection?.list_id ? [collection.list_id] : [],
          schedule_type: config.scheduleType,
          scheduled_at: config.scheduledAt,
          delivery_strategy: config.deliveryStrategy,
          target_local: config.targetLocal,
          default_timezone: config.defaultTimezone,
          adapter_id: 'html',
          rendered_html: html,
          exclude_sent_send_ids: config.excludeSentSendIds.length > 0 ? config.excludeSentSendIds : null,
          metadata: { web_version_url: webVersionUrl, portal_base_url: portalBaseUrl },
        }).select('id').single();
        if (error) throw error;
        return { id: data.id as string };
      },
      async rerenderContent(sendId: string) {
        const { html } = await buildFinalHtml();
        if (!html) throw new Error('Nothing to render yet');
        const { error } = await supabase.from('newsletter_sends')
          .update({ rendered_html: html, subject: subject || null, updated_at: new Date().toISOString() })
          .eq('id', sendId);
        if (error) throw error;
      },
      async sendTest(email: string) {
        // Mirrors the editor's working test-send: the route expects
        // recipient_email + the rendered html + subject (not { to }).
        const { html } = await buildFinalHtml();
        const apiUrl = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? '';
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(`${apiUrl}/api/admin/newsletters/editions/${editionId}/test-send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
          body: JSON.stringify({ recipient_email: email, html, subject: subject || 'Newsletter' }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: { message?: string } | string } | null;
          const msg = typeof body?.error === 'string' ? body.error : body?.error?.message;
          throw new Error(msg || `Test send failed (${res.status})`);
        }
      },
    };
  }, [editionId, editionStatus, subject, collection, newsletterSlug, buildFinalHtml]);

  return <SendingPanel adapter={adapter} />;
}
