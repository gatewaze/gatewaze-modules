import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from 'react';
import { useParams, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Card, Button, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { RichTextEditor } from '@/components/ui/RichTextEditor';
import { supabase } from '@/lib/supabase';
import { SendingPanel } from '@/components/sending';
import type { SendingAdapter, EmailDetails, SendComposerConfig } from '@/components/sending';
import {
  createSegmentService, createEmptySegmentDefinition, isValidSegmentDefinition,
  type SegmentDefinition, type SegmentMember,
} from '@/lib/segments';
// Cross-module reuse: the visual Segments Builder (controlled value/onChange).
import { SegmentBuilder } from '../../../segments/admin/pages/components/SegmentBuilder';
import SegmentCopilot from '../components/SegmentCopilot';
import { getBroadcast, updateBroadcast, createBroadcastSend, listEventsForLink, listCategoryLists, EVENT_VARIABLES, type Broadcast, type EventOption, type CategoryList } from '../lib/broadcastService';
import { BroadcastRepliesTab } from '../components/BroadcastRepliesTab';

const STEPS = [
  { id: 'audience', label: '1. Audience' },
  { id: 'content', label: '2. Content' },
  { id: 'sending', label: '3. Sending' },
  { id: 'replies', label: 'Replies' },
];

const inputCls = 'w-full rounded-md border border-[var(--gray-7)] bg-[var(--color-surface)] px-3 py-2 text-sm disabled:opacity-60';

export default function BroadcastDetailPage() {
  const { id, tab } = useParams<{ id: string; tab?: string }>();
  const navigate = useNavigate();
  const step = tab && STEPS.some((s) => s.id === tab) ? tab : 'audience';

  const [b, setB] = useState<Broadcast | null>(null);
  const [loading, setLoading] = useState(true);
  // Audience size for the Send indicator (the segment's cached member count).
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  // Step-specific top-right action (e.g. "Save audience & continue"), registered
  // by the active step — mirrors the newsletter editor's top-right Save/Publish.
  const [headerActions, setHeaderActions] = useState<ReactNode>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const data = await getBroadcast(id);
      if (!data) { toast.error('Broadcast not found'); navigate('/broadcasts'); return; }
      setB(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load broadcast');
    } finally {
      setLoading(false);
    }
  }, [id, navigate]);

  useEffect(() => { load(); }, [load]);

  // Load the audience size (segment member count) for the Send indicator.
  useEffect(() => {
    if (!b?.segment_id) { setAudienceCount(null); return; }
    let cancelled = false;
    createSegmentService(supabase).getSegment(b.segment_id)
      .then((seg) => { if (!cancelled) setAudienceCount(seg?.cached_count ?? null); })
      .catch(() => { if (!cancelled) setAudienceCount(null); });
    return () => { cancelled = true; };
  }, [b?.segment_id]);

  // Subscribable lists for the unsubscribe-list picker (now in the Sending tab).
  const [categoryLists, setCategoryLists] = useState<CategoryList[]>([]);
  useEffect(() => { listCategoryLists().then(setCategoryLists).catch(() => setCategoryLists([])); }, []);

  // Shared sending adapter — broadcasts edit their email-details inline (unlike
  // newsletters) and snapshot the parent's content/audience into each send.
  const broadcastAdapter: SendingAdapter | null = useMemo(() => {
    if (!b) return null;
    const hasAudience = b.audience_type === 'segment' ? !!b.segment_id : (b.list_ids?.length ?? 0) > 0;
    return {
      domainKey: 'broadcast',
      title: 'Send Broadcast',
      parentId: b.id,
      sendsTable: 'broadcast_sends',
      parentFkColumn: 'broadcast_id',
      logSendIdColumn: 'broadcast_send_id',
      tzBreakdownRpc: 'broadcast_send_timezone_breakdown',
      sendEndpoint: 'broadcast-send',
      // A broadcast can't send without content, an audience, AND an unsubscribe
      // list (the send is tied to that list; unsubscribing removes from it).
      canSend: !!b.rendered_html && hasAudience && !!b.category_list_id,
      canSendReason: !b.rendered_html ? 'Add content before sending'
        : !hasAudience ? 'Set an audience first'
        : !b.category_list_id ? 'Choose an unsubscribe list before sending'
        : undefined,
      features: { deliveryStrategy: true, excludeSent: true },
      emailDetails: {
        editable: true,
        values: {
          subject: b.subject || '',
          preheader: b.preheader || '',
          fromAddress: b.from_address || '',
          fromName: b.from_name || '',
          replyTo: b.reply_to || '',
          forwardRepliesTo: b.forward_replies_to || '',
        },
        async save(values: EmailDetails) {
          const nb = await updateBroadcast(b.id, {
            subject: values.subject || null,
            preheader: values.preheader || null,
            from_address: values.fromAddress || null,
            from_name: values.fromName || null,
            reply_to: values.replyTo || null,
            forward_replies_to: values.forwardRepliesTo || null,
          } as Partial<Broadcast>);
          setB(nb);
        },
      },
      recipients: {
        display: b.audience_type === 'segment'
          ? `Segment audience${audienceCount != null ? ` (${audienceCount.toLocaleString()})` : ''}`
          : `${b.list_ids?.length ?? 0} list${(b.list_ids?.length ?? 0) === 1 ? '' : 's'}`,
        editable: true,
        editHref: `/broadcasts/${b.id}/audience`,
        editLabel: 'Edit',
      },
      unsubscribeList: {
        options: categoryLists,
        value: b.category_list_id,
        required: true,
        label: 'Unsubscribe list',
        helpText: 'Required. Recipients unsubscribe from this list; the footer is added automatically, and only its subscribers within the audience are emailed.',
        async save(listId: string | null) {
          const nb = await updateBroadcast(b.id, { category_list_id: listId } as Partial<Broadcast>);
          setB(nb);
        },
      },
      recipientCount: audienceCount,
      async countRecipients(excludeSentSendIds: string[], unsubscribeListId?: string | null) {
        const { data, error } = await supabase.rpc('broadcast_recipient_preview_count', {
          p_audience_type: b.audience_type,
          p_segment_id: b.audience_type === 'segment' ? b.segment_id : null,
          p_list_ids: b.audience_type === 'list' ? (b.list_ids ?? []) : null,
          p_suppression_topic: 'broadcasts',
          p_exclude_send_ids: excludeSentSendIds.length > 0 ? excludeSentSendIds : null,
          // Cross-reference the audience with the selected list's subscribers.
          p_category_list_id: unsubscribeListId ?? b.category_list_id,
        });
        if (error) throw error;
        return (data as number) ?? 0;
      },
      async createSend(config: SendComposerConfig) {
        return createBroadcastSend(b.id, config);
      },
      async rerenderContent(sendId: string) {
        // Re-snapshot the parent's current content onto a not-yet-sent send,
        // so edits to the broadcast reach recipients still pending.
        const { error } = await supabase.from('broadcast_sends').update({
          subject: b.subject,
          preheader: b.preheader,
          from_address: b.from_address,
          from_name: b.from_name,
          reply_to: b.reply_to,
          rendered_html: b.rendered_html,
          content_json: b.content_json,
          updated_at: new Date().toISOString(),
        }).eq('id', sendId);
        if (error) throw error;
      },
      async sendTest(email: string) {
        // Test from the parent (no send instance needed) via broadcast-send.
        const { data, error } = await supabase.functions.invoke('broadcast-send', {
          body: { test_send: { broadcast_id: b.id, email } },
        });
        if (error) throw error;
        const res = data as { success?: boolean; error?: string } | null;
        if (!res?.success) throw new Error(res?.error || 'Test send failed');
      },
    };
  }, [b, audienceCount, categoryLists]);

  if (loading || !b) {
    return (
      <Page title="Broadcast">
        <WorkspaceLayout title="Broadcasts">
          <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" /></div>
        </WorkspaceLayout>
      </Page>
    );
  }

  // The parent broadcast (definition + content + audience) is always editable;
  // each send snapshots it, so editing it never mutates a send already in flight.
  const editable = true;
  const goTo = (s: string) => navigate(`/broadcasts/${b.id}/${s}`);

  return (
    <Page title={`Broadcast: ${b.name}`}>
      <WorkspaceLayout
        title={`Broadcasts: ${b.name}`}
        tabs={STEPS}
        activeTabId={step}
        onTabChange={goTo}
        actions={<div className="flex items-center gap-3">{headerActions}</div>}
      >
        {step === 'audience' && <AudienceStep b={b} editable={editable} setHeaderActions={setHeaderActions} onSaved={(nb) => { setB(nb); goTo('content'); }} />}
        {step === 'content' && <ContentStep b={b} editable={editable} setHeaderActions={setHeaderActions} onSaved={(nb) => { setB(nb); goTo('sending'); }} />}
        {step === 'sending' && broadcastAdapter && <SendingPanel adapter={broadcastAdapter} />}
        {step === 'replies' && <BroadcastRepliesTab broadcastId={b.id} />}
      </WorkspaceLayout>
    </Page>
  );
}

// --- Step 1: Audience (single-panel chat copilot, like the newsletter editor) -
function AudienceStep({ b, editable, setHeaderActions, onSaved }: { b: Broadcast; editable: boolean; setHeaderActions: (n: ReactNode) => void; onSaved: (b: Broadcast) => void }) {
  const [definition, setDefinition] = useState<SegmentDefinition>(createEmptySegmentDefinition());
  const [hasDefinition, setHasDefinition] = useState(false);
  const [loadedSeg, setLoadedSeg] = useState(false);
  const [saving, setSaving] = useState(false);
  const [suggestedName, setSuggestedName] = useState<string>('');
  const [count, setCount] = useState<number | null>(null);
  const [sample, setSample] = useState<SegmentMember[]>([]);

  // Load the existing backing segment's definition (if any).
  useEffect(() => {
    if (!b.segment_id) { setLoadedSeg(true); return; }
    createSegmentService(supabase).getSegment(b.segment_id)
      .then((seg) => { if (seg?.definition) { setDefinition(seg.definition); setHasDefinition(true); } })
      .catch(() => {})
      .finally(() => setLoadedSeg(true));
  }, [b.segment_id]);

  // Debounced live preview — count (status bar) + sample rows (preview table).
  useEffect(() => {
    if (!hasDefinition || !isValidSegmentDefinition(definition)) { setCount(null); setSample([]); return; }
    const t = setTimeout(() => {
      createSegmentService(supabase).previewSegment(definition)
        .then((r) => { setCount(r.count); setSample(r.sample ?? []); })
        .catch(() => { setCount(null); setSample([]); });
    }, 700);
    return () => clearTimeout(t);
  }, [definition, hasDefinition]);

  // Pin the panel to the viewport so the copilot is always fully visible and
  // its chat scrolls internally (mirrors the newsletter editor full-bleed).
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    function measure() {
      const el = wrapRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const viewportH = window.visualViewport?.height ?? window.innerHeight;
      const next = Math.max(360, Math.floor(viewportH - top - 24));
      setHeight((cur) => (cur !== next ? next : cur));
    }
    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro && wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [loadedSeg]);

  async function saveAndContinue() {
    if (!isValidSegmentDefinition(definition)) { toast.error('Describe an audience first'); return; }
    setSaving(true);
    try {
      const svc = createSegmentService(supabase);
      const name = (suggestedName || `${b.name} audience`).slice(0, 120);
      let segmentId = b.segment_id;
      if (segmentId) {
        await svc.updateSegment(segmentId, { definition });
        await svc.recalculateSegment(segmentId).catch(() => {});
      } else {
        const seg = await svc.createSegment({ name, definition });
        segmentId = seg.id;
      }
      const nb = await updateBroadcast(b.id, { audience_type: 'segment', segment_id: segmentId } as Partial<Broadcast>);
      toast.success('Audience saved');
      onSaved(nb);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save audience');
    } finally {
      setSaving(false);
    }
  }

  // Register the top-right header Save action (count lives in the panel status bar).
  useEffect(() => {
    if (!editable) { setHeaderActions(null); return () => setHeaderActions(null); }
    setHeaderActions(
      <Button variant="solid" onClick={saveAndContinue} disabled={saving || !hasDefinition}>{saving ? 'Saving…' : 'Save audience & continue'}</Button>,
    );
    return () => setHeaderActions(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, saving, hasDefinition, definition, suggestedName]);

  if (!loadedSeg) return <div className="py-10 text-center text-sm text-[var(--gray-10)]">Loading audience…</div>;

  return (
    <div ref={wrapRef} className="-mb-6 flex gap-4 overflow-hidden" style={{ height: height != null ? `${height}px` : 'calc(100vh - 260px)' }}>
      {/* Left: copilot — newsletter-editor look (light-grey panel, white composer). */}
      <div className="w-[400px] shrink-0 h-full overflow-hidden rounded-xl border border-[var(--gray-5)] bg-[var(--gray-2)]">
        <SegmentCopilot
          brand={b.brand}
          currentDefinition={hasDefinition ? definition : null}
          onDefinition={(def, meta) => { setDefinition(def); setHasDefinition(true); if (meta.suggestedName) setSuggestedName(meta.suggestedName); }}
        />
      </div>

      {/* Right: the segment builder — where the newsletter canvas normally sits.
          Builder scrolls; a status bar + data preview are fixed to the bottom. */}
      <div className="flex-1 h-full flex flex-col overflow-hidden rounded-xl border border-[var(--gray-5)] bg-[var(--gray-2)]">
        <div className="flex-1 overflow-y-auto p-4">
          <div className="text-sm font-medium text-[var(--gray-12)] mb-2">Audience criteria</div>
          <div className="rounded-lg border border-[var(--gray-5)] bg-[var(--color-surface)] p-4">
            <SegmentBuilder value={definition} onChange={(def) => { setDefinition(def); setHasDefinition(true); }} showPreview={false} />
          </div>
        </div>
        {/* Fixed bottom: status bar (count) + data preview table */}
        <div className="shrink-0 border-t border-[var(--gray-5)] bg-[var(--color-surface)]">
          <div className="px-4 py-2 border-b border-[var(--gray-5)] text-xs font-medium text-[var(--gray-11)]">
            {count == null ? 'No audience selected yet' : `${count.toLocaleString()} ${count === 1 ? 'person' : 'people'} in this filter`}
          </div>
          <AudiencePreviewTable definition={definition} sample={sample} />
        </div>
      </div>
    </div>
  );
}

// Compact data preview: always shows name/company/job title, plus any
// attribute fields the segment filters on (e.g. city). 5 rows, scrollable.
const ALWAYS_FIELDS: { key: string; label: string }[] = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'company', label: 'Company' },
  { key: 'job_title', label: 'Job title' },
];
const FIELD_LABELS: Record<string, string> = {
  city: 'City', country: 'Country', region: 'Region', email: 'Email',
  timezone: 'Timezone', linkedin_url: 'LinkedIn', twitter_handle: 'Twitter',
};
function labelFor(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}
function collectFilteredKeys(def: SegmentDefinition): string[] {
  const keys: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (conds: any[]) => {
    for (const c of conds ?? []) {
      if (c?.type === 'attribute' && typeof c.field === 'string') {
        keys.push(c.field === 'email' ? 'email' : c.field.replace(/^attributes\./, ''));
      } else if (c?.type === 'group') {
        walk(c.conditions);
      }
    }
  };
  walk(def.conditions);
  return Array.from(new Set(keys));
}
function memberValue(m: SegmentMember, key: string): string {
  if (key === 'email') return m.email ?? '';
  const v = (m.attributes as Record<string, unknown> | undefined)?.[key];
  return v == null ? '' : String(v);
}
function AudiencePreviewTable({ definition, sample }: { definition: SegmentDefinition; sample: SegmentMember[] }) {
  const extra = collectFilteredKeys(definition).filter((k) => !ALWAYS_FIELDS.some((f) => f.key === k));
  const columns = [...ALWAYS_FIELDS, ...extra.map((k) => ({ key: k, label: labelFor(k) }))];
  if (sample.length === 0) {
    return <div className="px-4 py-4 text-xs text-[var(--gray-10)]">No matching people to preview yet.</div>;
  }
  return (
    <div className="overflow-auto" style={{ maxHeight: 180 }}>
      <table className="w-full text-xs border-collapse">
        <thead className="sticky top-0 bg-[var(--gray-2)]">
          <tr>
            {columns.map((c) => (
              <th key={c.key} className="text-left font-medium text-[var(--gray-10)] px-3 py-1.5 whitespace-nowrap">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sample.map((m) => (
            <tr key={m.id} className="border-t border-[var(--gray-4)]">
              {columns.map((c) => (
                <td key={c.key} className="px-3 py-1.5 text-[var(--gray-12)] whitespace-nowrap">
                  {memberValue(m, c.key) || <span className="text-[var(--gray-8)]">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Step 2: Content (rich text) --------------------------------------------
function ContentStep({ b, editable, setHeaderActions, onSaved }: { b: Broadcast; editable: boolean; setHeaderActions: (n: ReactNode) => void; onSaved: (b: Broadcast) => void }) {
  const [html, setHtml] = useState<string>(b.rendered_html ?? '');
  const [saving, setSaving] = useState(false);
  // Optional linked event (CFP / event promotion) — supplies {{event_*}} vars.
  const [events, setEvents] = useState<EventOption[]>([]);
  const [eventId, setEventId] = useState<string>(b.event_id ?? '');

  useEffect(() => { listEventsForLink().then(setEvents).catch(() => setEvents([])); }, []);

  async function linkEvent(value: string) {
    setEventId(value);
    try {
      await updateBroadcast(b.id, { event_id: value || null } as Partial<Broadcast>);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to link event');
    }
  }

  async function saveAndContinue() {
    if (!html.trim()) { toast.error('Add some content'); return; }
    setSaving(true);
    try {
      // rendered_html is the body; the send path injects the unsubscribe footer.
      const nb = await updateBroadcast(b.id, { rendered_html: html, content_json: { html } } as Partial<Broadcast>);
      toast.success('Content saved');
      onSaved(nb);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save content');
    } finally {
      setSaving(false);
    }
  }

  // Save in the top-right header, like the audience step + newsletter editor.
  useEffect(() => {
    if (!editable) { setHeaderActions(null); return () => setHeaderActions(null); }
    setHeaderActions(
      <Button variant="solid" onClick={saveAndContinue} disabled={saving}>{saving ? 'Saving…' : 'Save content & continue'}</Button>,
    );
    return () => setHeaderActions(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, saving, html]);

  return (
    <div className="max-w-3xl space-y-3">
      <Card className="p-4">
        {/* Optional event link — for Call-for-Speakers / event promotion to a
            segment of the whole database. Adds {{event_*}} merge variables. */}
        <div className="mb-3">
          <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Linked event <span className="font-normal text-[var(--gray-10)]">(optional — for CFP / event promotion)</span></label>
          <select className={inputCls} value={eventId} onChange={(e) => linkEvent(e.target.value)} disabled={!editable}>
            <option value="">No linked event</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.event_title || '(untitled event)'}{ev.event_start ? ` — ${new Date(ev.event_start).toLocaleDateString()}` : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="text-sm font-medium text-[var(--gray-12)] mb-2">Message body</div>
        <p className="text-xs text-[var(--gray-10)] mb-1">Recipient merge fields: {'{{first_name}}'} {'{{name}}'} {'{{company}}'} {'{{job_title}}'}. The unsubscribe link is added automatically.</p>
        {eventId && (
          <p className="text-xs text-[var(--gray-10)] mb-3">Event variables: {EVENT_VARIABLES.map((v) => v.token).join(' ')} <span className="text-[var(--gray-9)]">(filled from the linked event when sent)</span></p>
        )}
        <RichTextEditor content={html} onChange={setHtml} />
      </Card>
    </div>
  );
}

export { inputCls };
