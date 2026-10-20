import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, CopyButton, PageLoadingSpinner } from '@/components/ui';
import { FORMATS, PLATFORMS } from '../../lib/formats';
import { socialPostsService, type Draft, type DraftStatus } from '../utils/socialPostsService';

const STATUS_COLOR: Record<DraftStatus, 'gray' | 'green' | 'blue' | 'cyan' | 'orange'> = {
  draft: 'gray',
  ready: 'green',
  scheduled: 'blue',
  posted: 'cyan',
  archived: 'orange',
};

const STATUS_LABEL: Record<DraftStatus, string> = {
  draft: 'Draft',
  ready: 'Ready',
  scheduled: 'Scheduled',
  posted: 'Posted',
  archived: 'Archived',
};

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

interface Props {
  drafts: Draft[] | null;
  error: string | null;
  onOpen: (d: Draft) => void;
  /** Called with the draft as saved, so an open copy of it can follow. */
  onChanged: (d: Draft) => void;
}

export function DraftsList({ drafts, error, onOpen, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);

  async function setStatus(d: Draft, status: 'draft' | 'ready' | 'archived') {
    setBusy(d.id);
    try {
      const saved = await socialPostsService.updateDraft(d.id, { status });
      toast.success(status === 'archived' ? 'Draft archived' : `Marked ${STATUS_LABEL[status].toLowerCase()}`);
      onChanged(saved);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the draft');
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p className="text-sm text-[var(--red-11)]">{error}</p>;
  if (drafts === null) return <PageLoadingSpinner label="Loading drafts" />;
  if (drafts.length === 0) {
    return <p className="py-12 text-center text-sm text-[var(--gray-a10)]">No drafts yet. Write a post and save it.</p>;
  }

  return (
    <div className="space-y-3">
      {drafts.map((d) => {
        const hook = d.body.split('\n').find((l) => l.trim()) ?? '';
        const editable = d.status === 'draft' || d.status === 'ready' || d.status === 'archived';
        return (
          <Card key={d.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[var(--gray-12)] line-clamp-2">{hook}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-[var(--gray-a10)]">
                  <Badge color={STATUS_COLOR[d.status]} variant="soft" size="1">{STATUS_LABEL[d.status]}</Badge>
                  <Badge color="gray" variant="soft" size="1">{PLATFORMS[d.platform]?.label ?? d.platform}</Badge>
                  <span>{FORMATS[d.format]?.label ?? d.format}</span>
                  <span>· {d.body.length.toLocaleString()} chars</span>
                  <span>· updated {when(d.updated_at)}</span>
                </div>
                {d.sources.length > 0 && (
                  <p className="mt-1.5 text-xs text-[var(--gray-a10)] line-clamp-1">
                    From: {d.sources.slice().sort((a, b) => a.position - b.position).map((s) => s.title ?? s.content_type).join(' · ')}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button size="1" variant="soft" onClick={() => onOpen(d)}>Open</Button>
                <CopyButton value={d.body}>
                  {({ copy, copied }) => (
                    <Button size="1" variant="soft" color="gray" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
                  )}
                </CopyButton>
                {editable && d.status !== 'ready' && (
                  <Button size="1" variant="soft" color="green" disabled={busy === d.id} onClick={() => void setStatus(d, 'ready')}>Mark ready</Button>
                )}
                {editable && d.status !== 'draft' && (
                  <Button size="1" variant="soft" color="gray" disabled={busy === d.id} onClick={() => void setStatus(d, 'draft')}>Back to draft</Button>
                )}
                {editable && d.status !== 'archived' && (
                  <Button size="1" variant="soft" color="orange" disabled={busy === d.id} onClick={() => void setStatus(d, 'archived')}>Archive</Button>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
