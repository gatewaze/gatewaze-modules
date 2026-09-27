import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowDownTrayIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardIcon,
  TrashIcon,
  CheckCircleIcon,
  StarIcon,
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
} from '@heroicons/react/24/outline';
import { rotateMedia } from '../utils/rotateMedia';
import { Button, Modal } from '@/components/ui';
import {
  type HostMediaItem,
  mediaKind,
  guestName,
  formatFileSize,
  formatDuration,
} from '../utils/mediaOrganizerService';
import type { TileChips } from './MediaGrid';
import { PhotoArtifacts } from './PhotoArtifacts';

interface MediaViewerModalProps {
  items: HostMediaItem[];
  index: number;
  chips: TileChips;
  onNavigate: (index: number) => void;
  onClose: () => void;
  onPatch: (item: HostMediaItem, fields: Record<string, unknown>) => Promise<boolean>;
  onDelete: (item: HostMediaItem) => void;
  /** An edit made inside the viewer (the Wedflix card), for the organiser's list. */
  onItemChange?: (item: HostMediaItem) => void;
  /** The event these photos belong to, for turning one on its side. */
  eventId?: string;
  /** Re-read the list; a turned photo has new files and new URLs. */
  onRefresh?: () => Promise<void> | void;
}

export function MediaViewerModal({ items, index, chips, onNavigate, onClose, onPatch, onDelete, onItemChange, eventId, onRefresh }: MediaViewerModalProps) {
  const item = items[index];
  const [caption, setCaption] = useState('');
  const [altText, setAltText] = useState('');
  const [saving, setSaving] = useState(false);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [turning, setTurning] = useState(false);

  useEffect(() => {
    if (!item) return;
    setCaption(item.caption ?? '');
    setAltText(item.alt_text ?? '');
    setImgSrc(item.medium_url ?? item.cdn_url);
  }, [item]);

  /**
   * Turn the photograph, and its 3D layers with it, then show the
   * result. The old files go once the row points at the new ones, so a
   * failure part-way through leaves the photograph as it was.
   */
  const rotate = async (quarters: 1 | 2 | 3) => {
    if (!item || !eventId || turning) return;
    setTurning(true);
    try {
      await rotateMedia(eventId, item as never, quarters);
      // The turned photo has new file names -- so new thumbnail and
      // preview URLs too, all of them built on the server. Re-read the
      // list rather than guessing at them here; the old files are gone.
      await onRefresh?.();
      toast.success('Turned');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not turn that photo');
    } finally {
      setTurning(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Leave arrow keys alone while typing in the caption fields.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft' && index > 0) onNavigate(index - 1);
      if (e.key === 'ArrowRight' && index < items.length - 1) onNavigate(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, items.length, onNavigate]);

  if (!item) return null;
  const kind = mediaKind(item);
  const guest = guestName(item);
  const isYouTube = !!item.youtube_embed_url && item.youtube_upload_status === 'completed';
  const dirty = caption !== (item.caption ?? '') || altText !== (item.alt_text ?? '');
  const originalUrl = isYouTube ? item.youtube_url ?? item.cdn_url : item.cdn_url;

  const saveText = async () => {
    setSaving(true);
    const ok = await onPatch(item, { caption: caption.trim() || null, alt_text: altText.trim() || null });
    setSaving(false);
    if (ok) toast.success('Saved');
  };

  const download = () => {
    if (isYouTube) { window.open(originalUrl, '_blank', 'noopener'); return; }
    const a = document.createElement('a');
    a.href = originalUrl;
    a.download = item.filename;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`${item.caption || item.filename}  ·  ${index + 1} of ${items.length}`}
      size="2xl"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onNavigate(index - 1)} disabled={index === 0} title="Previous (←)">
              <ChevronLeftIcon className="h-4 w-4" /> Previous
            </Button>
            <Button variant="outline" onClick={() => onNavigate(index + 1)} disabled={index >= items.length - 1} title="Next (→)">
              Next <ChevronRightIcon className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {!item.is_approved && (
              <Button color="green" onClick={() => onPatch(item, { is_approved: true })}>
                <CheckCircleIcon className="h-4 w-4" /> Approve
              </Button>
            )}
            <Button variant="outline" onClick={() => onPatch(item, { is_featured: !item.is_featured })}>
              <StarIcon className="h-4 w-4" /> {item.is_featured ? 'Unfeature' : 'Feature'}
            </Button>
            {kind === 'photo' && eventId && (
              <>
                <Button variant="outline" disabled={turning} title="Rotate left" onClick={() => void rotate(3)}>
                  <ArrowUturnLeftIcon className="h-4 w-4" /> {turning ? 'Turning…' : 'Rotate left'}
                </Button>
                <Button variant="outline" disabled={turning} title="Rotate right" onClick={() => void rotate(1)}>
                  <ArrowUturnRightIcon className="h-4 w-4" /> Rotate right
                </Button>
              </>
            )}
            <Button
              variant="outline"
              onClick={async () => {
                try { await navigator.clipboard.writeText(originalUrl); toast.success('Link copied'); }
                catch { toast.error('Could not copy link'); }
              }}
            >
              <ClipboardIcon className="h-4 w-4" /> Copy link
            </Button>
            <Button variant="outline" onClick={download}>
              <ArrowDownTrayIcon className="h-4 w-4" /> {isYouTube ? 'Open on YouTube' : 'Download'}
            </Button>
            <Button
              variant="outline"
              color="red"
              onClick={() => onDelete(item)}
              disabled={item.used_in.length > 0}
              title={item.used_in.length > 0 ? `Used in ${item.used_in.length} place(s); remove it there first` : 'Delete'}
            >
              <TrashIcon className="h-4 w-4" /> Delete
            </Button>
          </div>
        </div>
      }
    >
      <>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex items-center justify-center overflow-hidden rounded-lg bg-[var(--gray-a3)]">
          {kind === 'photo' && imgSrc ? (
            <img
              src={imgSrc}
              alt={item.alt_text || item.caption || item.filename}
              className="max-h-[70vh] w-auto object-contain"
              onError={() => { if (imgSrc !== item.cdn_url) setImgSrc(item.cdn_url); }}
            />
          ) : isYouTube ? (
            <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
              <iframe
                src={item.youtube_embed_url!}
                title={item.caption || item.filename}
                className="absolute left-0 top-0 h-full w-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          ) : kind === 'video' ? (
            <video src={item.cdn_url} controls className="max-h-[70vh] w-full" />
          ) : kind === 'audio' ? (
            <audio src={item.cdn_url} controls className="m-8 w-full" />
          ) : (
            <p className="p-8 text-sm text-[var(--gray-a10)]">No preview for {item.mime_type}</p>
          )}
        </div>

        <div className="space-y-4 text-sm">
          <div className="space-y-2">
            <label className="block text-xs font-medium text-[var(--gray-a10)]">Caption</label>
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={2}
              maxLength={2000}
              className="w-full rounded-md border border-[var(--gray-a6)] bg-transparent px-2 py-1.5"
            />
            <label className="block text-xs font-medium text-[var(--gray-a10)]">Alt text</label>
            <input
              value={altText}
              onChange={(e) => setAltText(e.target.value)}
              maxLength={2000}
              className="w-full rounded-md border border-[var(--gray-a6)] bg-transparent px-2 py-1.5"
            />
            {dirty && (
              <Button size="sm" onClick={saveText} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            )}
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
            <dt className="text-[var(--gray-a10)]">Status</dt>
            <dd>
              {item.is_approved ? 'Approved' : <span className="text-[var(--amber-11)]">Pending approval</span>}
              {item.is_featured ? ' · Featured' : ''}
            </dd>
            <dt className="text-[var(--gray-a10)]">Type</dt>
            <dd>{item.mime_type}</dd>
            <dt className="text-[var(--gray-a10)]">Size</dt>
            <dd>{formatFileSize(item.bytes)}</dd>
            {item.width && item.height ? (<><dt className="text-[var(--gray-a10)]">Dimensions</dt><dd>{item.width} × {item.height}</dd></>) : null}
            {item.duration ? (<><dt className="text-[var(--gray-a10)]">Duration</dt><dd>{formatDuration(item.duration)}</dd></>) : null}
            <dt className="text-[var(--gray-a10)]">Uploaded</dt>
            <dd>{new Date(item.created_at).toLocaleString()}{guest ? ` by ${guest}` : ''}</dd>
            <dt className="text-[var(--gray-a10)]">File</dt>
            <dd className="break-all">{item.filename}</dd>
            {item.youtube_upload_status && (<><dt className="text-[var(--gray-a10)]">YouTube</dt><dd>{item.youtube_upload_status}</dd></>)}
            <dt className="text-[var(--gray-a10)]">Albums</dt>
            <dd>{chips.albums.length ? chips.albums.map((a) => a.name).join(', ') : '—'}</dd>
            <dt className="text-[var(--gray-a10)]">Sponsors</dt>
            <dd>{chips.sponsors.length ? chips.sponsors.map((s) => s.name).join(', ') : '—'}</dd>
            {item.used_in.length > 0 && (
              <>
                <dt className="text-[var(--gray-a10)]">Used in</dt>
                <dd>{item.used_in.map((u) => `${u.type}: ${u.name}`).join(', ')}</dd>
              </>
            )}
          </dl>
        </div>
      </div>
      {kind === 'photo' && <PhotoArtifacts item={item} onItemChange={onItemChange} />}
      </>
    </Modal>
  );
}
