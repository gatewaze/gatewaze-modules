/**
 * Polymorphic media tab — same component for sites, events,
 * newsletters, blog, podcasts. Reads its feature flags
 * (enableAlbums, enableSponsorTagging, enableYouTube, enableZipUnpack)
 * from a `consumer` prop. The host module that mounts this tab supplies
 * the consumer block from its own hostMediaConsumer manifest entry.
 *
 * Per spec-host-media-module §4.5.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Input, Select, Modal } from '@/components/ui';
import {
  ArrowUpTrayIcon,
  MagnifyingGlassIcon,
  PhotoIcon,
  VideoCameraIcon,
  TrashIcon,
  ClipboardIcon,
  FolderIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import {
  listHostMedia,
  uploadHostMedia,
  deleteHostMedia,
  listAlbums,
  createAlbum,
  deleteAlbum,
} from '../utils/hostMediaService';
import type { HostMediaItem, HostMediaAlbum } from '../../client-types';

export interface HostMediaTabConsumer {
  hostKind: string;
  enableAlbums?: boolean;
  enableSponsorTagging?: boolean;
  enableYouTube?: boolean;
  enableZipUnpack?: boolean;
}

export interface HostMediaTabProps {
  hostId: string;
  consumer: HostMediaTabConsumer;
}

type Filter = 'all' | 'photo' | 'video' | 'audio';

export function HostMediaTab({ hostId, consumer }: HostMediaTabProps) {
  const { hostKind } = consumer;

  const [items, setItems] = useState<HostMediaItem[]>([]);
  const [albums, setAlbums] = useState<HostMediaAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState<HostMediaItem | null>(null);
  const [albumModalOpen, setAlbumModalOpen] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const acceptStr = useMemo(() => {
    const types = ['image/*', 'video/*', 'audio/*'];
    if (consumer.enableZipUnpack) types.push('application/zip');
    return types.join(',');
  }, [consumer.enableZipUnpack]);

  const reload = async () => {
    setLoading(true);
    try {
      const resp = await listHostMedia(hostKind, hostId, {
        filter,
        album_id: selectedAlbumId ?? undefined,
        search: search || undefined,
      });
      if (resp.ok) {
        const body = await resp.json();
        setItems(body.items ?? []);
      } else {
        setItems([]);
      }
    } catch {
      setItems([]);
    }
    setLoading(false);
  };

  const reloadAlbums = async () => {
    if (!consumer.enableAlbums) return;
    try {
      const resp = await listAlbums(hostKind, hostId);
      if (resp.ok) {
        const body = await resp.json();
        setAlbums(body.albums ?? []);
      }
    } catch {
      setAlbums([]);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostKind, hostId, filter, selectedAlbumId]);

  useEffect(() => {
    reloadAlbums();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostKind, hostId, consumer.enableAlbums]);

  const onUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const resp = await uploadHostMedia(hostKind, hostId, files, {
        album_id: selectedAlbumId ?? undefined,
      });
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
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    }
    setUploading(false);
  };

  const onDelete = async (item: HostMediaItem) => {
    if (item.used_in.length > 0) {
      toast.error(`Cannot delete: used in ${item.used_in.length} place${item.used_in.length === 1 ? '' : 's'}`);
      return;
    }
    if (!window.confirm(`Delete ${item.filename}?`)) return;
    try {
      const resp = await deleteHostMedia(hostKind, hostId, item.id);
      if (resp.status === 204) {
        toast.success('Deleted');
        setSelected(null);
        reload();
      } else {
        const body = await resp.json();
        toast.error(body.message ?? 'Delete failed');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const onCreateAlbum = async () => {
    if (newAlbumName.trim().length === 0) return;
    try {
      const resp = await createAlbum(hostKind, hostId, { name: newAlbumName.trim() });
      if (resp.ok) {
        toast.success('Album created');
        setNewAlbumName('');
        setAlbumModalOpen(false);
        reloadAlbums();
      } else {
        const body = await resp.json();
        toast.error(body.message ?? 'Create failed');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Create failed');
    }
  };

  const onDeleteAlbum = async (album: HostMediaAlbum) => {
    if (!window.confirm(`Delete album "${album.name}"? Media will be moved to "All".`)) return;
    try {
      const resp = await deleteAlbum(hostKind, hostId, album.id);
      if (resp.status === 204) {
        toast.success('Album deleted');
        if (selectedAlbumId === album.id) setSelectedAlbumId(null);
        reloadAlbums();
        reload();
      } else {
        const body = await resp.json();
        toast.error(body.message ?? 'Delete failed');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const filtered = items.filter((i) => !search || i.filename.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-4">
      {consumer.enableAlbums && albums.length > 0 && (
        <Card>
          <div className="p-3 flex flex-wrap gap-2 items-center">
            <span className="text-sm text-[var(--gray-a8)] mr-2">Albums:</span>
            <button
              type="button"
              onClick={() => setSelectedAlbumId(null)}
              className={`text-xs px-2 py-1 rounded ${selectedAlbumId === null ? 'bg-[var(--accent-9)] text-white' : 'bg-[var(--gray-a3)]'}`}
            >
              All
            </button>
            {albums.map((a) => (
              <button
                type="button"
                key={a.id}
                onClick={() => setSelectedAlbumId(a.id)}
                onDoubleClick={() => onDeleteAlbum(a)}
                title="Double-click to delete"
                className={`text-xs px-2 py-1 rounded ${selectedAlbumId === a.id ? 'bg-[var(--accent-9)] text-white' : 'bg-[var(--gray-a3)]'}`}
              >
                {a.name}
              </button>
            ))}
            <Button size="1" variant="outlined" onClick={() => setAlbumModalOpen(true)}>
              <FolderIcon className="size-4" /> + Album
            </Button>
          </div>
        </Card>
      )}

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
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setFilter(e.target.value as Filter)}
            data={[
              { value: 'all', label: 'All' },
              { value: 'photo', label: 'Photos' },
              { value: 'video', label: 'Videos' },
              { value: 'audio', label: 'Audio' },
            ]}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={acceptStr}
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
              Upload images{consumer.enableYouTube ? ', videos (uploaded to YouTube)' : ' and videos'}
              {consumer.enableZipUnpack ? ', or a zip of media' : ''} for this {hostKind}.
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {filtered.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => setSelected(item)}
              className="group relative aspect-square rounded-md overflow-hidden border border-[var(--gray-a4)] hover:border-[var(--accent-9)] transition-colors text-left bg-[var(--gray-a2)]"
            >
              {item.mime_type.startsWith('image/') ? (
                <img src={item.cdn_url} alt={item.filename} className="w-full h-full object-cover" loading="lazy" />
              ) : item.mime_type.startsWith('video/') ? (
                item.youtube_thumbnail_url ? (
                  <img src={item.youtube_thumbnail_url} alt={item.filename} className="w-full h-full object-cover" loading="lazy" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <VideoCameraIcon className="size-12 text-[var(--gray-a6)]" />
                  </div>
                )
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
                  {item.youtube_upload_status && item.youtube_upload_status !== 'completed' && (
                    <Badge variant="soft" color="orange" size="1">YT: {item.youtube_upload_status}</Badge>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

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
            {selected.youtube_embed_url && (
              <iframe
                title={selected.filename}
                className="w-full aspect-video rounded-md"
                src={selected.youtube_embed_url}
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
              />
            )}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-[var(--gray-a8)]">Type</dt>
              <dd>{selected.mime_type}</dd>
              <dt className="text-[var(--gray-a8)]">Size</dt>
              <dd>{formatBytes(selected.bytes)}</dd>
              {selected.width !== null && selected.height !== null && (
                <>
                  <dt className="text-[var(--gray-a8)]">Dimensions</dt>
                  <dd>{selected.width} × {selected.height}</dd>
                </>
              )}
              {selected.duration !== null && (
                <>
                  <dt className="text-[var(--gray-a8)]">Duration</dt>
                  <dd>{Math.round(selected.duration)} s</dd>
                </>
              )}
              <dt className="text-[var(--gray-a8)]">Storage</dt>
              <dd>{selected.in_repo ? 'In repo' : 'CDN only'}</dd>
              {selected.youtube_upload_status && (
                <>
                  <dt className="text-[var(--gray-a8)]">YouTube</dt>
                  <dd>{selected.youtube_upload_status}{selected.youtube_url ? ` — ${selected.youtube_url}` : ''}</dd>
                </>
              )}
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

      {consumer.enableAlbums && (
        <Modal
          isOpen={albumModalOpen}
          onClose={() => setAlbumModalOpen(false)}
          title="New album"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="outlined" onClick={() => setAlbumModalOpen(false)}>Cancel</Button>
              <Button onClick={onCreateAlbum}>Create</Button>
            </div>
          }
        >
          <Input
            placeholder="Album name"
            value={newAlbumName}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewAlbumName(e.target.value)}
            autoFocus
          />
        </Modal>
      )}
    </div>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export default HostMediaTab;
