/**
 * Media tab — per-site media library.
 *
 * Per spec-content-modules-git-architecture §14.4:
 *   - Grid view of media items (thumbnail, name, size, used-in count)
 *   - Search + filter (photos | videos | all)
 *   - Drag-and-drop multi-upload
 *   - Click → modal with full preview, copy URL, replace, delete
 *
 * Same component used on newsletter list detail (different host_kind).
 */

import { useEffect, useState, useRef } from 'react';
import { Badge, Button, Card, Input, Select, Modal } from '@/components/ui';
import { ArrowUpTrayIcon, MagnifyingGlassIcon, PhotoIcon, TrashIcon, ClipboardIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import type { SiteRow } from '../../types';

export interface MediaItem {
  id: string;
  filename: string;
  mime_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  storage_path: string;
  cdn_url: string;
  variants: Record<string, string> | null;
  in_repo: boolean;
  used_in: Array<{ type: string; id: string; name: string }>;
  uploaded_by: string | null;
  created_at: string;
}

interface MediaTabProps {
  site?: SiteRow;
  hostKind?: 'site' | 'list';
  hostId?: string;
}

export function SiteMediaTab(props: MediaTabProps) {
  const hostKind = props.hostKind ?? 'site';
  const hostId = props.hostId ?? props.site?.id;
  if (!hostId) throw new Error('SiteMediaTab requires site or {hostKind, hostId}');

  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'photo' | 'video'>('all');
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const resp = await fetch(`/api/${hostKind}/${hostId}/media`);
      if (resp.ok) {
        const body = await resp.json();
        setItems(body.items ?? []);
      }
    } catch (err) {
      // Endpoint not yet wired — show empty state
      setItems([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostKind, hostId]);

  const onUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append('files', f));
    try {
      const resp = await fetch(`/api/${hostKind}/${hostId}/media`, { method: 'POST', body: fd });
      const body = await resp.json();
      if (resp.status === 207) {
        const ok = body.items.filter((i: { status: string }) => i.status === 'created').length;
        const fail = body.items.length - ok;
        toast.warning(`Uploaded ${ok} file${ok === 1 ? '' : 's'}, ${fail} failed`);
      } else if (resp.ok) {
        toast.success(`Uploaded ${body.items.length} file${body.items.length === 1 ? '' : 's'}`);
      } else {
        toast.error(body.message ?? 'Upload failed');
      }
      load();
    } catch (err) {
      toast.error('Upload failed (endpoint not yet implemented)');
    }
    setUploading(false);
  };

  const onDelete = async (item: MediaItem) => {
    if (item.used_in.length > 0) {
      toast.error(`Cannot delete: used in ${item.used_in.length} place${item.used_in.length === 1 ? '' : 's'}`);
      return;
    }
    if (!window.confirm(`Delete ${item.filename}?`)) return;
    try {
      const resp = await fetch(`/api/${hostKind}/${hostId}/media/${item.id}`, { method: 'DELETE' });
      if (resp.status === 204) {
        toast.success('Deleted');
        setSelected(null);
        load();
      } else {
        const body = await resp.json();
        toast.error(body.message ?? 'Delete failed');
      }
    } catch (err) {
      toast.error('Delete failed (endpoint not yet implemented)');
    }
  };

  const filtered = items
    .filter((i) =>
      filter === 'all'
        ? true
        : filter === 'photo'
          ? i.mime_type.startsWith('image/')
          : i.mime_type.startsWith('video/')
    )
    .filter((i) => !search || i.filename.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-4">
      <Card>
        <div className="p-4 flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-[var(--gray-a8)] pointer-events-none" />
            <Input
              placeholder="Search media…"
              value={search}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select
            value={filter}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setFilter(e.target.value as 'all' | 'photo' | 'video')}
            data={[
              { value: 'all', label: 'All' },
              { value: 'photo', label: 'Photos' },
              { value: 'video', label: 'Videos' },
            ]}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,video/*"
            className="hidden"
            onChange={(e) => onUpload(e.target.files)}
          />
          <Button onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            <ArrowUpTrayIcon className="size-4" />
            {uploading ? 'Uploading…' : '+ Upload'}
          </Button>
        </div>
      </Card>

      {loading ? (
        <Card><div className="p-8 flex justify-center"><LoadingSpinner /></div></Card>
      ) : filtered.length === 0 ? (
        <Card>
          <div className="p-8 text-center">
            <PhotoIcon className="mx-auto size-12 text-[var(--gray-a6)]" />
            <h3 className="mt-2 text-sm font-medium">No media yet</h3>
            <p className="mt-1 text-sm text-[var(--gray-a8)]">
              Upload images and videos for this {hostKind}.
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {filtered.map((item) => (
            <button
              key={item.id}
              onClick={() => setSelected(item)}
              className="group relative aspect-square rounded-md overflow-hidden border border-[var(--gray-a4)] hover:border-[var(--accent-9)] transition-colors text-left bg-[var(--gray-a2)]"
            >
              {item.mime_type.startsWith('image/') ? (
                <img
                  src={item.cdn_url}
                  alt={item.filename}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <PhotoIcon className="size-12 text-[var(--gray-a6)]" />
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/70 to-transparent">
                <p className="text-xs text-white font-medium truncate">{item.filename}</p>
                <div className="flex items-center gap-1 text-[10px] text-white/80">
                  <span>{formatBytes(item.bytes)}</span>
                  {item.used_in.length > 0 && <span>• used in {item.used_in.length}</span>}
                  {item.in_repo && <Badge variant="soft" color="blue" size="1">repo</Badge>}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Detail modal */}
      <Modal
        isOpen={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.filename ?? ''}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="outlined"
              onClick={() => {
                if (selected) {
                  navigator.clipboard.writeText(selected.cdn_url);
                  toast.success('CDN URL copied');
                }
              }}
            >
              <ClipboardIcon className="size-4" /> Copy CDN URL
            </Button>
            <Button
              color="error"
              variant="outlined"
              onClick={() => selected && onDelete(selected)}
              disabled={!selected || selected.used_in.length > 0}
            >
              <TrashIcon className="size-4" /> Delete
            </Button>
          </div>
        }
      >
        {selected && (
          <div className="space-y-4">
            {selected.mime_type.startsWith('image/') && (
              <img src={selected.cdn_url} alt={selected.filename} className="max-w-full rounded-md" />
            )}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-[var(--gray-a8)]">Type</dt>
              <dd>{selected.mime_type}</dd>
              <dt className="text-[var(--gray-a8)]">Size</dt>
              <dd>{formatBytes(selected.bytes)}</dd>
              {selected.width && (
                <>
                  <dt className="text-[var(--gray-a8)]">Dimensions</dt>
                  <dd>{selected.width} × {selected.height}</dd>
                </>
              )}
              <dt className="text-[var(--gray-a8)]">Storage</dt>
              <dd>{selected.in_repo ? 'In repo' : 'CDN only'}</dd>
              <dt className="text-[var(--gray-a8)]">Reference</dt>
              <dd className="font-mono text-xs">{`/media/${selected.filename}`}</dd>
            </dl>
            {selected.used_in.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Used in:</p>
                <ul className="text-sm space-y-1">
                  {selected.used_in.map((u) => (
                    <li key={`${u.type}:${u.id}`} className="text-[var(--gray-a8)]">
                      {u.type}: {u.name}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
