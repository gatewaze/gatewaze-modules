import { useMemo, useState } from 'react';
import { ClipboardDocumentCheckIcon, ClipboardDocumentIcon, SparklesIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Badge, Button, Card, CopyButton, Select, Textarea } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { checkItemCount, FORMAT_IDS, FORMATS, isFormat, PLATFORMS, type Format, type Platform } from '../../lib/formats';
import { socialPostsService, type DraftStatus } from '../utils/socialPostsService';
import { keyOf, type SelectedItem } from './ContentPicker';

/** The post being written: either new, or a saved draft opened from the Drafts tab. */
export interface ComposerState {
  draftId: string | null;
  draftStatus: DraftStatus | null;
  format: Format;
  instructions: string;
  text: string;
  hashtags: string[];
  mentions: string[];
  model: string | null;
  generated: boolean;
  /** Regenerated since the draft was opened or last saved. */
  regenerated: boolean;
  warnings: string[];
}

export const EMPTY_COMPOSER: ComposerState = {
  draftId: null,
  draftStatus: null,
  format: 'announcement',
  instructions: '',
  text: '',
  hashtags: [],
  mentions: [],
  model: null,
  generated: false,
  regenerated: false,
  warnings: [],
};

interface Props {
  platform: Platform;
  selected: SelectedItem[];
  onRemove: (item: SelectedItem) => void;
  state: ComposerState;
  setState: (updater: (s: ComposerState) => ComposerState) => void;
  onSaved: () => void;
  onNew: () => void;
}

export function Composer({ platform, selected, onRemove, state, setState, onSaved, onNew }: Props) {
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const p = PLATFORMS[platform];
  const countError = checkItemCount(state.format, selected.length);
  const length = state.text.length;
  const locked = state.draftStatus === 'scheduled' || state.draftStatus === 'posted';

  const formatOptions = useMemo(() => FORMAT_IDS.map((id) => ({ value: id, label: FORMATS[id].label })), []);

  async function generate() {
    if (countError) return;
    setGenerating(true);
    try {
      const r = await socialPostsService.generate({
        platform,
        format: state.format,
        items: selected.map((s) => ({ content_type: s.content_type, content_id: s.content_id })),
        ...(state.instructions.trim() ? { instructions: state.instructions.trim() } : {}),
      });
      setState((s) => ({ ...s, text: r.text, hashtags: r.hashtags, mentions: r.mentions, model: r.model, generated: true, regenerated: !!s.draftId, warnings: r.warnings }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not write the post');
    } finally {
      setGenerating(false);
    }
  }

  async function save(status: 'draft' | 'ready') {
    if (!state.text.trim()) return;
    setSaving(true);
    try {
      if (state.draftId) {
        const d = await socialPostsService.updateDraft(state.draftId, {
          body: state.text,
          format: state.format,
          status,
          hashtags: state.hashtags,
          ...(state.regenerated ? { regenerated: true as const, ai_model: state.model, instructions: state.instructions.trim() || null } : {}),
        });
        setState((s) => ({ ...s, draftStatus: d.status, mentions: d.mentions, regenerated: false }));
        toast.success(status === 'ready' ? 'Draft saved and marked ready' : 'Draft saved');
      } else {
        const r = await socialPostsService.createDraft({
          platform,
          format: state.format,
          status,
          body: state.text,
          hashtags: state.hashtags,
          instructions: state.instructions.trim() || null,
          ai_model: state.model,
          generated: state.generated,
          sources: selected.map((s) => ({ content_type: s.content_type, content_id: s.content_id })),
        });
        setState((s) => ({ ...s, draftId: r.id, draftStatus: status, mentions: r.mentions }));
        toast.success(status === 'ready' ? 'Draft saved and marked ready' : 'Draft saved');
      }
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the draft');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-[var(--gray-12)]">
            {state.draftId ? 'Edit draft' : `New ${p.label} post`}
          </h2>
          <p className="text-xs text-[var(--gray-a10)] mt-0.5">Drafts only. Nothing is posted to {p.label}.</p>
        </div>
        {(state.draftId || state.text) && (
          <Button size="1" variant="soft" color="gray" onClick={onNew}>New post</Button>
        )}
      </div>

      <div>
        <div className="text-xs font-medium text-[var(--gray-11)] mb-1.5">Writing from</div>
        {selected.length === 0 ? (
          <p className="text-sm text-[var(--gray-a10)]">Pick items from the curated content list.</p>
        ) : (
          <ol className="space-y-1">
            {selected.map((s, i) => (
              <li key={keyOf(s)} className="flex items-center gap-2 text-sm">
                <span className="text-xs text-[var(--gray-a9)] w-4 text-right">{i + 1}.</span>
                <span className="min-w-0 flex-1 truncate text-[var(--gray-12)]" title={s.title}>{s.title}</span>
                <Badge color="gray" variant="soft" size="1">{s.typeLabel}</Badge>
                {!state.draftId && (
                  <button type="button" onClick={() => onRemove(s)} className="text-[var(--gray-a9)] hover:text-[var(--red-11)]" aria-label={`Remove ${s.title}`}>
                    <XMarkIcon className="size-4" />
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      <Select
        label="Format"
        value={state.format}
        data={formatOptions}
        disabled={locked}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
          const v = e.target.value;
          if (isFormat(v)) setState((s) => ({ ...s, format: v }));
        }}
      />

      <Textarea
        label="Extra direction (optional)"
        placeholder="e.g. Mention that registration closes Friday. Keep it under 800 characters."
        rows={2}
        maxLength={1000}
        value={state.instructions}
        disabled={locked}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
          const v = e.target.value;
          setState((s) => ({ ...s, instructions: v }));
        }}
      />

      {!locked && (
        <div className="flex items-center gap-3">
          <Button onClick={() => void generate()} disabled={generating || !!countError}>
            {generating ? <LoadingSpinner size="xs" /> : <SparklesIcon className="size-4" />}
            {state.text ? 'Regenerate' : 'Generate'}
          </Button>
          {countError && selected.length > 0 && <span className="text-xs text-[var(--orange-11)]">{countError}</span>}
        </div>
      )}

      {(state.text || generating) && (
        <div className="space-y-2">
          <Textarea
            label="Post"
            rows={14}
            value={state.text}
            disabled={generating || locked}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
              const v = e.target.value;
              setState((s) => ({ ...s, text: v }));
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className={length > p.maxChars ? 'text-[var(--red-11)] font-medium' : length > p.targetChars ? 'text-[var(--orange-11)]' : 'text-[var(--gray-a10)]'}>
              {length.toLocaleString()} / {p.maxChars.toLocaleString()} characters
              {length > p.targetChars && length <= p.maxChars && ' (long for a feed post)'}
            </span>
            {state.mentions.length > 0 && (
              <span className="text-[var(--gray-a10)]">Tag on {p.label}: {state.mentions.join(', ')}</span>
            )}
          </div>
          {state.text && (
            <div className="rounded-md border border-[var(--gray-a5)] bg-[var(--gray-a2)] p-3">
              <div className="text-[11px] uppercase tracking-wide text-[var(--gray-a9)] mb-1">Shown before "see more"</div>
              <p className="text-sm text-[var(--gray-12)] whitespace-pre-line">
                {state.text.slice(0, p.foldChars)}{state.text.length > p.foldChars ? '…' : ''}
              </p>
            </div>
          )}
          {state.warnings.length > 0 && (
            <ul className="text-xs text-[var(--orange-11)] list-disc pl-4">
              {state.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <CopyButton value={state.text}>
              {({ copy, copied }) => (
                <Button variant="soft" onClick={copy} disabled={!state.text}>
                  {copied ? <ClipboardDocumentCheckIcon className="size-4" /> : <ClipboardDocumentIcon className="size-4" />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              )}
            </CopyButton>
            {!locked && (
              <>
                <Button variant="soft" color="gray" onClick={() => void save('draft')} disabled={saving || generating || !state.text.trim() || length > p.maxChars}>
                  {saving ? <LoadingSpinner size="xs" /> : null}
                  {state.draftId ? 'Save' : 'Save draft'}
                </Button>
                <Button variant="soft" color="green" onClick={() => void save('ready')} disabled={saving || generating || !state.text.trim() || length > p.maxChars}>
                  {state.draftStatus === 'ready' ? 'Save (ready)' : 'Save as ready'}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
