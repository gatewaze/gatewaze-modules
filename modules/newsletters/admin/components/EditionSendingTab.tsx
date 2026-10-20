import { useMemo, useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { SendingPanel } from '@/components/sending';
import type { SendingAdapter, SendComposerConfig } from '@/components/sending';
import { getViewOnlineUrl } from '../utils/view-online-url';
import { parseSendGateError, sendGateMessage, type SendGate } from '../utils/researchService';

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
  /** The edition's preheader (current editor state, same source as the rendered HTML). Required to send. */
  preheader?: string | null;
  collection: CollectionInfo | null;
  newsletterSlug?: string;
  editionStatus?: string;
  /** Async renderer producing the final email-safe HTML for the edition. */
  getRenderedHtml?: () => Promise<string>;
  /** Block id → label, so the research send gate can name the offending block. */
  blockNames?: Record<string, string>;
}

/**
 * Ask newsletters_send_gate (migration 094) whether the edition may be sent.
 * The same function backs the BEFORE INSERT trigger on newsletter_sends, which
 * is the enforcement; this call exists so the author sees the reason in words.
 * A missing function (pre-migration) or a query error does not block: the
 * trigger still has the final say.
 */
async function checkSendGate(editionId: string): Promise<SendGate | null> {
  const { data, error } = await supabase.rpc('newsletters_send_gate', { p_edition_id: editionId });
  if (error) {
    console.warn('[newsletter-send] send gate check failed:', error.message);
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as SendGate | null | undefined;
  return row ?? null;
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
export function EditionSendingTab({ editionId, editionDate, subject, preheader, collection, newsletterSlug, editionStatus, getRenderedHtml, blockNames }: EditionSendingTabProps) {
  // Research send gate (spec §5.3): shown as the "can't send yet" reason so
  // the author learns it before the insert. Re-checked when the tab mounts
  // and after every send attempt; the DB trigger remains the enforcement.
  const [gate, setGate] = useState<SendGate | null>(null);
  const refreshGate = useCallback(async () => {
    if (!editionId || editionId === 'new') { setGate(null); return; }
    setGate(await checkSendGate(editionId));
  }, [editionId]);
  useEffect(() => { void refreshGate(); }, [refreshGate]);
  // A scheduled send the dispatcher is holding on the research gate (it stays
  // 'scheduled' and goes out once research completes; dispatch-scheduled.ts
  // records why in last_error).
  const [held, setHeld] = useState<Array<{ id: string; last_error: string }>>([]);
  useEffect(() => {
    if (!editionId || editionId === 'new') { setHeld([]); return; }
    let cancelled = false;
    void supabase
      .from('newsletter_sends')
      .select('id, last_error')
      .eq('edition_id', editionId)
      .eq('status', 'scheduled')
      .not('last_error', 'is', null)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) { console.warn('[newsletter-send] held-send check failed:', error.message); return; }
        setHeld((data as Array<{ id: string; last_error: string }>) ?? []);
      });
    return () => { cancelled = true; };
  }, [editionId, gate]);
  const gateReason = gate && !gate.allowed ? sendGateMessage(gate.reason_code, gate.block_id ? blockNames?.[gate.block_id] : null) : undefined;
  // Render the edition to final email HTML with the web-version link substituted
  // (shared by createSend + rerenderContent so both produce identical output).
  const buildFinalHtml = useCallback(async (): Promise<{ html: string | null; webVersionUrl: string; portalBaseUrl: string }> => {
    const portalProtocol = typeof window !== 'undefined' ? window.location.protocol : 'https:';
    // Prefer the brand's CONFIGURED portal domain (platform_settings.domain) so
    // brands whose portal isn't on the apex (e.g. portal on www.tech.tickets
    // while admin is admin.tech.tickets) get correct unsubscribe /
    // manage-preferences + view-online links. Fall back to deriving from the
    // admin hostname (admin.X -> X apex) for apex-portal brands.
    const fallbackHost = typeof window !== 'undefined'
      ? window.location.hostname.replace('-admin.', '-app.').replace(/^admin\./, '')
      : 'localhost';
    let portalBaseUrl = `${portalProtocol}//${fallbackHost}`;
    try {
      const { data } = await supabase.from('platform_settings').select('value').eq('key', 'domain').maybeSingle();
      const domain = (data?.value as string | null | undefined)?.trim();
      if (domain) {
        portalBaseUrl = /^https?:\/\//i.test(domain)
          ? domain.replace(/\/+$/, '')
          : `${portalProtocol}//${domain.replace(/\/+$/, '')}`;
      }
    } catch {
      // keep the hostname-derived fallback
    }
    const webVersionUrl = getViewOnlineUrl(
      { slug: newsletterSlug, view_online_target: collection?.view_online_target, view_online_external_base_url: collection?.view_online_external_base_url },
      { edition_date: editionDate, subject },
      portalBaseUrl,
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
    const hasPreheader = !!preheader && preheader.trim().length > 0;
    return {
      domainKey: 'newsletter',
      title: 'Send Newsletter',
      parentId: isNew ? '' : editionId,
      sendsTable: 'newsletter_sends',
      parentFkColumn: 'edition_id',
      logSendIdColumn: 'newsletter_send_id',
      tzBreakdownRpc: 'newsletter_send_timezone_breakdown',
      sendEndpoint: 'newsletter-send',
      // A preheader is mandatory: Gmail sends mail without one to spam.
      // Migration 090 enforces the same rule on newsletter_sends inserts.
      canSend: editionStatus === 'published' && hasPreheader && !gateReason,
      canSendReason: isNew
        ? 'Save the edition first'
        : editionStatus !== 'published'
          ? 'This edition is a draft. Publish it before sending — the email’s “View Online” link points at the published page.'
          : !hasPreheader
            ? 'Add a preheader on the Details tab before sending'
            : gateReason,
      features: { deliveryStrategy: true, excludeSent: true },
      emailDetails: {
        editable: false,
        editHref: settingsHref,
        editLabel: 'Edit in settings',
        values: {
          subject: subject || '',
          preheader: preheader || '',
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
      async previewSchedule(config: SendComposerConfig) {
        if (!collection?.list_id || !config.scheduledAt) return [];
        const { data, error } = await supabase.rpc('newsletter_preview_send_schedule', {
          p_list_id: collection.list_id,
          p_scheduled_at: config.scheduledAt,
          p_target_local: config.targetLocal,
          p_default_timezone: config.defaultTimezone,
        });
        if (error) throw error;
        return (data as { timezone: string; recipients: number; send_at: string }[]) || [];
      },
      async createSend(config: SendComposerConfig) {
        // Research send gate first, so the author gets words rather than a
        // database error. The BEFORE INSERT trigger below is the enforcement.
        const g = await checkSendGate(editionId);
        if (g && !g.allowed) {
          setGate(g);
          throw new Error(sendGateMessage(g.reason_code, g.block_id ? blockNames?.[g.block_id] : null));
        }
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
          // Recorded on the send for history; the trigger rejects a blank one.
          preheader: preheader?.trim() || null,
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
        if (error) {
          // The trigger raised SEND_GATE:<code>:<block> (check_violation): same
          // words as the pre-check, since the state may have changed in between.
          const gated = parseSendGateError(error.message);
          if (gated) {
            void refreshGate();
            throw new Error(sendGateMessage(gated.code, gated.block_id ? blockNames?.[gated.block_id] : null));
          }
          throw error;
        }
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
  }, [editionId, editionStatus, subject, preheader, collection, newsletterSlug, buildFinalHtml, gateReason, blockNames, refreshGate]);

  return (
    <>
      {held.map((h) => {
        const g = parseSendGateError(h.last_error);
        return (
          <div key={h.id} className="mb-3 rounded-md border border-[var(--orange-a6)] bg-[var(--orange-a2)] p-3 text-sm text-[var(--orange-11)]">
            A scheduled send is being held and will go out once this is resolved:{' '}
            {g ? sendGateMessage(g.code, g.block_id ? blockNames?.[g.block_id] : null) : h.last_error}
          </div>
        );
      })}
      <SendingPanel adapter={adapter} />
    </>
  );
}
