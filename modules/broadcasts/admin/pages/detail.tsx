import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
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
        actions={
          <div className="flex items-center gap-3">
            {headerActions}
            <Badge color={b.status === 'sent' ? 'green' : b.status === 'failed' ? 'red' : b.status === 'sending' ? 'amber' : 'gray'}>{b.status}</Badge>
          </div>
        }
      >
        {step === 'audience' && <AudienceStep b={b} editable={editable} setHeaderActions={setHeaderActions} onSaved={(nb) => { setB(nb); goTo('content'); }} />}
        {step === 'content' && <ContentStep b={b} editable={editable} setHeaderActions={setHeaderActions} onSaved={(nb) => { setB(nb); goTo('sending'); }} />}
        {step === 'sending' && <BroadcastSendingPanel broadcast={b} reload={load} />}
      </WorkspaceLayout>
    </Page>
  );
}

// --- Step 1: Audience (single-panel chat copilot, like the newsletter editor) -
function AudienceStep({ b, editable, setHeaderActions, onSaved }: { b: BroadcastSend; editable: boolean; setHeaderActions: (n: ReactNode) => void; onSaved: (b: BroadcastSend) => void }) {
  const [definition, setDefinition] = useState<SegmentDefinition>(createEmptySegmentDefinition());
  const [hasDefinition, setHasDefinition] = useState(false);
  const [loadedSeg, setLoadedSeg] = useState(false);
  const [saving, setSaving] = useState(false);
  const [suggestedName, setSuggestedName] = useState<string>('');
  const [count, setCount] = useState<number | null>(null);

  // Load the existing backing segment's definition (if any).
  useEffect(() => {
    if (!b.segment_id) { setLoadedSeg(true); return; }
    createSegmentService(supabase).getSegment(b.segment_id)
      .then((seg) => { if (seg?.definition) { setDefinition(seg.definition); setHasDefinition(true); } })
      .catch(() => {})
      .finally(() => setLoadedSeg(true));
  }, [b.segment_id]);

  // Debounced live count (shown in the header beside Save).
  useEffect(() => {
    if (!hasDefinition || !isValidSegmentDefinition(definition)) { setCount(null); return; }
    const t = setTimeout(() => {
      createSegmentService(supabase).previewSegment(definition)
        .then((r) => setCount(r.count))
        .catch(() => setCount(null));
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
      const nb = await updateBroadcast(b.id, { audience_type: 'segment', segment_id: segmentId } as Partial<BroadcastSend>);
      toast.success('Audience saved');
      onSaved(nb);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save audience');
    } finally {
      setSaving(false);
    }
  }

  // Register the top-right header action (count + Save), like the editor.
  useEffect(() => {
    if (!editable) { setHeaderActions(null); return () => setHeaderActions(null); }
    setHeaderActions(
      <div className="flex items-center gap-3">
        {count != null && <span className="text-sm text-[var(--gray-11)]">≈ {count.toLocaleString()} people</span>}
        <Button variant="solid" onClick={saveAndContinue} disabled={saving || !hasDefinition}>{saving ? 'Saving…' : 'Save audience & continue'}</Button>
      </div>,
    );
    return () => setHeaderActions(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, saving, count, hasDefinition, definition, suggestedName]);

  if (!loadedSeg) return <div className="py-10 text-center text-sm text-[var(--gray-10)]">Loading audience…</div>;

  return (
    <div ref={wrapRef} className="-mb-6" style={{ height: height != null ? `${height}px` : 'calc(100vh - 260px)' }}>
      <div className="h-full max-w-3xl mx-auto overflow-hidden rounded-xl border border-[var(--gray-5)] bg-[var(--color-surface)]">
        <SegmentCopilot
          brand={b.brand}
          currentDefinition={hasDefinition ? definition : null}
          onDefinition={(def, meta) => { setDefinition(def); setHasDefinition(true); if (meta.suggestedName) setSuggestedName(meta.suggestedName); }}
        />
      </div>
    </div>
  );
}

// --- Step 2: Content (rich text) --------------------------------------------
function ContentStep({ b, editable, setHeaderActions, onSaved }: { b: BroadcastSend; editable: boolean; setHeaderActions: (n: ReactNode) => void; onSaved: (b: BroadcastSend) => void }) {
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
        <div className="text-sm font-medium text-[var(--gray-12)] mb-2">Message body</div>
        <p className="text-xs text-[var(--gray-10)] mb-3">Merge fields: {'{{first_name}}'} {'{{name}}'} {'{{company}}'} {'{{job_title}}'}. The unsubscribe link is added automatically.</p>
        <RichTextEditor content={html} onChange={setHtml} />
      </Card>
    </div>
  );
}

export { inputCls };
