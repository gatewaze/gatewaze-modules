import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Card, Button, Badge, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { RichTextEditor } from '@/components/ui/RichTextEditor';
import { supabase } from '@/lib/supabase';
import {
  createSegmentService, createEmptySegmentDefinition, isValidSegmentDefinition,
  type SegmentDefinition,
} from '@/lib/segments';
// Cross-module reuse: the visual Segments Builder (controlled value/onChange).
import { SegmentBuilder } from '../../../segments/admin/pages/components/SegmentBuilder';
import SegmentCopilot from '../components/SegmentCopilot';
import BroadcastSendingPanel from '../components/BroadcastSendingPanel';
import { getBroadcast, updateBroadcast, type BroadcastSend } from '../lib/broadcastService';

const STEPS = [
  { id: 'audience', label: '1. Audience' },
  { id: 'content', label: '2. Content' },
  { id: 'sending', label: '3. Sending' },
];

const inputCls = 'w-full rounded-md border border-[var(--gray-7)] bg-[var(--color-surface)] px-3 py-2 text-sm disabled:opacity-60';

export default function BroadcastDetailPage() {
  const { id, tab } = useParams<{ id: string; tab?: string }>();
  const navigate = useNavigate();
  const step = tab && STEPS.some((s) => s.id === tab) ? tab : 'audience';

  const [b, setB] = useState<BroadcastSend | null>(null);
  const [loading, setLoading] = useState(true);

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

  if (loading || !b) {
    return (
      <Page title="Broadcast">
        <WorkspaceLayout title="Broadcasts">
          <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" /></div>
        </WorkspaceLayout>
      </Page>
    );
  }

  const editable = b.status === 'draft' || b.status === 'scheduled';
  const goTo = (s: string) => navigate(`/broadcasts/${b.id}/${s}`);

  return (
    <Page title={`Broadcast: ${b.name}`}>
      <WorkspaceLayout
        title={`Broadcasts: ${b.name}`}
        tabs={STEPS}
        activeTabId={step}
        onTabChange={goTo}
        actions={<Badge color={b.status === 'sent' ? 'green' : b.status === 'failed' ? 'red' : b.status === 'sending' ? 'amber' : 'gray'}>{b.status}</Badge>}
      >
        {step === 'audience' && <AudienceStep b={b} editable={editable} onSaved={(nb) => { setB(nb); goTo('content'); }} />}
        {step === 'content' && <ContentStep b={b} editable={editable} onSaved={(nb) => { setB(nb); goTo('sending'); }} />}
        {step === 'sending' && <BroadcastSendingPanel broadcast={b} reload={load} />}
      </WorkspaceLayout>
    </Page>
  );
}

// --- Step 1: Audience (chat copilot + editable builder) ---------------------
function AudienceStep({ b, editable, onSaved }: { b: BroadcastSend; editable: boolean; onSaved: (b: BroadcastSend) => void }) {
  const [definition, setDefinition] = useState<SegmentDefinition>(createEmptySegmentDefinition());
  const [loadedSeg, setLoadedSeg] = useState(false);
  const [saving, setSaving] = useState(false);
  const [suggestedName, setSuggestedName] = useState<string>('');
  const [count, setCount] = useState<number | null>(null);

  // Load the existing backing segment's definition (if any) into the builder.
  useEffect(() => {
    if (!b.segment_id) { setLoadedSeg(true); return; }
    createSegmentService(supabase).getSegment(b.segment_id)
      .then((seg) => { if (seg?.definition) setDefinition(seg.definition); })
      .catch(() => {})
      .finally(() => setLoadedSeg(true));
  }, [b.segment_id]);

  // Compact live count (no sample list) — debounced. Replaces SegmentBuilder's
  // own preview so the panel stays small.
  useEffect(() => {
    if (!isValidSegmentDefinition(definition)) { setCount(null); return; }
    const t = setTimeout(() => {
      createSegmentService(supabase).previewSegment(definition)
        .then((r) => setCount(r.count))
        .catch(() => setCount(null));
    }, 700);
    return () => clearTimeout(t);
  }, [definition]);

  // Pin the step to the viewport so the copilot stays visible and the criteria
  // scroll on the right (mirrors the newsletter editor full-bleed pattern).
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
    if (!isValidSegmentDefinition(definition)) { toast.error('Add at least one valid condition'); return; }
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
      const nb = await updateBroadcast(b.id, { audience_type: 'segment', segment_id: segmentId } as Partial<BroadcastSend>);
      toast.success('Audience saved');
      onSaved(nb);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save audience');
    } finally {
      setSaving(false);
    }
  }

  if (!loadedSeg) return <div className="py-10 text-center text-sm text-[var(--gray-10)]">Loading audience…</div>;

  return (
    <div ref={wrapRef} className="flex gap-4 overflow-hidden -mb-6" style={{ height: height != null ? `${height}px` : 'calc(100vh - 260px)' }}>
      {/* Left: copilot — fixed, always visible (chat scrolls internally) */}
      <Card className="p-4 w-[420px] shrink-0 h-full overflow-hidden flex flex-col">
        <SegmentCopilot
          brand={b.brand}
          currentDefinition={definition}
          onDefinition={(def, meta) => { setDefinition(def); if (meta.suggestedName) setSuggestedName(meta.suggestedName); }}
        />
      </Card>

      {/* Right: audience criteria — scrolls; compact count header; sticky save footer */}
      <div className="flex-1 h-full flex flex-col overflow-hidden rounded-xl border border-[var(--gray-5)] bg-[var(--gray-2)]">
        <div className="px-4 pt-3 pb-2 border-b border-[var(--gray-5)] flex items-center justify-between shrink-0">
          <div>
            <div className="text-sm font-medium text-[var(--gray-12)]">Audience criteria</div>
            <p className="text-xs text-[var(--gray-10)]">Edit any condition, or ask the copilot to refine.</p>
          </div>
          <span className="shrink-0 inline-flex items-center rounded-full bg-[var(--accent-3)] text-[var(--accent-11)] px-3 py-1 text-xs font-medium">
            {count == null ? 'No audience yet' : `≈ ${count.toLocaleString()} people`}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <SegmentBuilder value={definition} onChange={setDefinition} showPreview={false} />
        </div>
        {editable && (
          <div className="px-4 py-3 border-t border-[var(--gray-5)] flex justify-end shrink-0">
            <Button variant="solid" onClick={saveAndContinue} disabled={saving}>{saving ? 'Saving…' : 'Save audience & continue'}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Step 2: Content (rich text) --------------------------------------------
function ContentStep({ b, editable, onSaved }: { b: BroadcastSend; editable: boolean; onSaved: (b: BroadcastSend) => void }) {
  const [html, setHtml] = useState<string>(b.rendered_html ?? '');
  const [saving, setSaving] = useState(false);

  async function saveAndContinue() {
    if (!html.trim()) { toast.error('Add some content'); return; }
    setSaving(true);
    try {
      // rendered_html is the body; the send path injects the unsubscribe footer.
      const nb = await updateBroadcast(b.id, { rendered_html: html, content_json: { html } } as Partial<BroadcastSend>);
      toast.success('Content saved');
      onSaved(nb);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save content');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-3">
      <Card className="p-4">
        <div className="text-sm font-medium text-[var(--gray-12)] mb-2">Message body</div>
        <p className="text-xs text-[var(--gray-10)] mb-3">Merge fields: {'{{first_name}}'} {'{{name}}'} {'{{company}}'} {'{{job_title}}'}. The unsubscribe link is added automatically.</p>
        <RichTextEditor content={html} onChange={setHtml} />
      </Card>
      {editable && (
        <div className="flex justify-end">
          <Button variant="solid" onClick={saveAndContinue} disabled={saving}>{saving ? 'Saving…' : 'Save content & continue'}</Button>
        </div>
      )}
    </div>
  );
}

export { inputCls };
