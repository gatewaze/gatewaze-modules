import { useState } from 'react';
import { SparklesIcon, CheckIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { createSegmentService, type SegmentDefinition, type SegmentCondition } from '@/lib/segments';
import { buildSegmentFromPrompt, type CopilotResult } from '../lib/broadcastService';

interface Props {
  brand?: string;
  /** Called with the saved segment id + a human label once the admin accepts. */
  onAttach: (segmentId: string, label: string, count: number | null) => void;
}

/** Render a single condition as a readable chip label. */
function describeCondition(c: SegmentCondition): string {
  if (c.type === 'attribute') {
    const field = c.field.replace(/^attributes\./, '');
    return `${field} ${c.operator.replace(/_/g, ' ')} ${formatValue(c.value)}`.trim();
  }
  if (c.type === 'event') {
    const filt = (c.event_filters ?? c.property_filters ?? [])
      .map((f) => `${f.property} ${f.operator.replace(/_/g, ' ')} ${formatValue(f.value)}`)
      .join(', ');
    const win = c.time_window
      ? c.time_window.type === 'relative'
        ? ` in last ${c.time_window.relative_value} ${c.time_window.relative_unit}`
        : ' (date range)'
      : '';
    return `${c.operator.replace(/_/g, ' ')} ${c.event_type}${filt ? ` [${filt}]` : ''}${win}`;
  }
  if (c.type === 'group') {
    return `(${c.conditions.map(describeCondition).join(c.match === 'all' ? ' AND ' : ' OR ')})`;
  }
  return 'condition';
}

function formatValue(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

export default function SegmentCopilot({ brand, onAttach }: Props) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CopilotResult | null>(null);
  const [saving, setSaving] = useState(false);

  async function run() {
    if (!prompt.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const r = await buildSegmentFromPrompt(prompt.trim(), brand);
      setResult(r);
      if (!r.success) toast.error(r.error || 'Could not build a segment — try rephrasing');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Copilot failed');
    } finally {
      setLoading(false);
    }
  }

  async function accept() {
    if (!result?.definition) return;
    setSaving(true);
    try {
      const svc = createSegmentService(supabase);
      const name = result.suggested_name?.trim() || prompt.trim().slice(0, 80) || 'AI segment';
      const seg = await svc.createSegment({ name, definition: result.definition as SegmentDefinition });
      onAttach(seg.id, name, result.count ?? null);
      toast.success(`Segment "${name}" created and attached`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save segment');
    } finally {
      setSaving(false);
    }
  }

  const conditions = result?.definition?.conditions ?? [];

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center gap-2 text-[var(--gray-12)] font-medium">
        <SparklesIcon className="h-5 w-5 text-[var(--accent-9)]" /> Describe your audience
      </div>
      <p className="text-sm text-[var(--gray-11)]">
        e.g. “everyone who attended the last San Francisco Forum event” or “all people in New York and the surrounding area”.
      </p>
      <div className="flex gap-2">
        <textarea
          className="flex-1 rounded-md border border-[var(--gray-7)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          rows={2}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe who should receive this…"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(); }}
        />
        <Button variant="solid" onClick={run} disabled={loading || !prompt.trim()}>
          {loading ? 'Building…' : 'Build'}
        </Button>
      </div>

      {result?.success && (
        <div className="space-y-3 border-t border-[var(--gray-5)] pt-3">
          {result.explanation && <p className="text-sm text-[var(--gray-12)]">{result.explanation}</p>}

          <div className="flex flex-wrap gap-2">
            <span className="text-xs uppercase tracking-wide text-[var(--gray-10)] self-center">
              Match {result.definition?.match === 'all' ? 'ALL' : 'ANY'}:
            </span>
            {conditions.map((c, i) => (
              <span key={i} className="inline-flex items-center rounded-full bg-[var(--accent-3)] text-[var(--accent-11)] px-3 py-1 text-xs">
                {describeCondition(c)}
              </span>
            ))}
          </div>

          {result.warnings && result.warnings.length > 0 && (
            <ul className="text-xs text-[var(--amber-11)] list-disc pl-5 space-y-1">
              {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}

          <div className="flex items-center justify-between">
            <div className="text-sm text-[var(--gray-11)]">
              {result.count == null ? 'Count unavailable' : <><strong className="text-[var(--gray-12)]">≈ {result.count.toLocaleString()}</strong> people</>}
              {result.sample && result.sample.length > 0 && (
                <span className="text-[var(--gray-10)]"> · e.g. {result.sample.slice(0, 3).map((s) => s.email).join(', ')}</span>
              )}
            </div>
            <Button variant="solid" onClick={accept} disabled={saving}>
              <CheckIcon className="h-4 w-4 mr-1" /> {saving ? 'Saving…' : 'Use this audience'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
