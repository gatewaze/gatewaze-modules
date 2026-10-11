/**
 * Upload photos, videos or a ZIP into the event's media library.
 *
 * Files go to the host-media upload endpoint in small batches with real
 * progress (XHR). ZIPs are unpacked in the browser: every image/video
 * inside is uploaded, and each top-level folder becomes an album (an
 * existing album with the same name is reused) — the legacy "folders
 * become albums" behaviour, without the server-side unzip pipeline.
 */

import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowUpTrayIcon, XMarkIcon, DocumentArrowUpIcon } from '@heroicons/react/24/outline';
import { Button, Modal } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { addManyToAlbum, createAlbum, errorMessage } from '@gatewaze-modules/host-media/admin';
import { HOST_KIND, formatFileSize, type HostMediaAlbum } from '../utils/mediaOrganizerService';

interface MediaUploadModalProps {
  eventId: string;
  albums: HostMediaAlbum[];
  /** Album preselected from the organizer's current album filter. */
  defaultAlbumId: string | null;
  onClose: () => void;
  onDone: () => void;
}

type Mode = 'files' | 'zip';
type ItemStatus = 'queued' | 'uploading' | 'done' | 'failed';

interface QueueItem {
  key: string;
  file: File;
  /** Album name taken from the ZIP folder, if any. */
  folder: string | null;
  status: ItemStatus;
  progress: number;
  error?: string;
  mediaId?: string;
}

// Server limits: multer caps each file at 50 MB; keep each request under
// the 50 MB ingress body size most installs use.
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_BATCH_BYTES = 40 * 1024 * 1024;
const MAX_BATCH_FILES = 10;
const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024;
const CONCURRENCY = 2;

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
};

function mimeFor(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? null;
}

function isMedia(file: File): boolean {
  return /^(image|video|audio)\//.test(file.type) || mimeFor(file.name) !== null;
}

const apiUrl = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';

interface UploadResultItem { filename: string; status: 'created' | 'failed'; media_id?: string; message?: string }

/** POSTs one batch with progress. Resolves with the per-file results; throws on transport errors. */
function postBatch(
  eventId: string,
  files: File[],
  caption: string,
  onProgress: (fraction: number) => void,
): Promise<{ status: number; retryAfter: number; items: UploadResultItem[]; message?: string }> {
  return new Promise((resolve, reject) => {
    void supabase.auth.getSession().then(({ data }) => {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f, f.name));
      if (caption) fd.append('caption', caption);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${apiUrl}/api/admin/${HOST_KIND}/${eventId}/media`);
      const token = data.session?.access_token;
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.onload = () => {
        let body: { items?: UploadResultItem[]; message?: string } = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }
        resolve({
          status: xhr.status,
          retryAfter: Number(xhr.getResponseHeader('Retry-After')) || 10,
          items: body.items ?? [],
          message: body.message,
        });
      };
      xhr.send(fd);
    }, reject);
  });
}

function batchesOf(items: QueueItem[]): QueueItem[][] {
  const out: QueueItem[][] = [];
  let cur: QueueItem[] = [];
  let bytes = 0;
  for (const it of items) {
    if (cur.length > 0 && (cur.length >= MAX_BATCH_FILES || bytes + it.file.size > MAX_BATCH_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += it.file.size;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function MediaUploadModal({ eventId, albums, defaultAlbumId, onClose, onDone }: MediaUploadModalProps) {
  const [mode, setMode] = useState<Mode>('files');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [caption, setCaption] = useState('');
  const [albumIds, setAlbumIds] = useState<string[]>(defaultAlbumId ? [defaultAlbumId] : []);
  const [foldersAsAlbums, setFoldersAsAlbums] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [unzipping, setUnzipping] = useState(false);
  const [running, setRunning] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);

  const totals = useMemo(() => {
    const bytes = queue.reduce((s, q) => s + q.file.size, 0);
    const sent = queue.reduce((s, q) => s + q.file.size * (q.status === 'done' ? 1 : q.progress), 0);
    return {
      bytes,
      pct: bytes ? Math.round((sent / bytes) * 100) : 0,
      done: queue.filter((q) => q.status === 'done').length,
      failed: queue.filter((q) => q.status === 'failed').length,
    };
  }, [queue]);

  const addFiles = (files: File[], folderOf?: (f: File) => string | null) => {
    const accepted: QueueItem[] = [];
    let rejected = 0;
    for (const original of files) {
      if (!isMedia(original)) { rejected++; continue; }
      // Browsers leave type empty for some formats (HEIC on desktop);
      // the server dispatches on the multipart content type, so set it.
      const f = original.type
        ? original
        : new File([original], original.name, { type: mimeFor(original.name)!, lastModified: original.lastModified });
      if (f.size > MAX_FILE_BYTES) {
        toast.error(`${f.name} is larger than 50 MB and was skipped`);
        continue;
      }
      accepted.push({
        key: `${f.name}-${f.size}-${f.lastModified}-${Math.random().toString(36).slice(2)}`,
        file: f,
        folder: folderOf ? folderOf(original) : null,
        status: 'queued',
        progress: 0,
      });
    }
    if (rejected) toast.warning(`${rejected} file(s) skipped: not a photo, video or audio file`);
    setQueue((q) => [...q, ...accepted]);
  };

  const unzip = async (zipFile: File) => {
    if (zipFile.size > MAX_ZIP_BYTES) { toast.error('ZIP files must be under 2 GB'); return; }
    setUnzipping(true);
    try {
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(zipFile);
      const files: File[] = [];
      const folders = new Map<File, string | null>();
      const entries = Object.values(zip.files).filter((e) => {
        if (e.dir) return false;
        const parts = e.name.split('/');
        // Skip macOS resource forks and dotfiles.
        return !parts.some((p) => p === '__MACOSX' || p.startsWith('.')) && mimeFor(e.name) !== null;
      });
      for (const entry of entries) {
        const blob = await entry.async('blob');
        const parts = entry.name.split('/');
        const name = parts[parts.length - 1]!;
        const file = new File([blob], name, { type: mimeFor(name)! });
        files.push(file);
        // Top-level folder name; a flat ZIP has none.
        folders.set(file, parts.length > 1 ? parts[0]! : null);
      }
      if (files.length === 0) { toast.error('No photos or videos found in the ZIP'); return; }
      addFiles(files, (f) => folders.get(f) ?? null);
      toast.success(`Found ${files.length} file(s) in ${zipFile.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? `Could not read ZIP: ${err.message}` : 'Could not read ZIP');
    } finally {
      setUnzipping(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    const zips = files.filter((f) => /\.zip$/i.test(f.name));
    zips.forEach((z) => void unzip(z));
    addFiles(files.filter((f) => !/\.zip$/i.test(f.name)));
  };

  const patchItem = (key: string, patch: Partial<QueueItem>) =>
    setQueue((q) => q.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  /** Resolves album ids for ZIP folders, creating missing albums. */
  const folderAlbums = async (items: QueueItem[]): Promise<Map<string, string>> => {
    const byName = new Map(albums.map((a) => [a.name.toLowerCase(), a.id]));
    const out = new Map<string, string>();
    const names = Array.from(new Set(items.map((i) => i.folder).filter((f): f is string => !!f)));
    for (const name of names) {
      const existing = byName.get(name.toLowerCase());
      if (existing) { out.set(name, existing); continue; }
      const resp = await createAlbum(HOST_KIND, eventId, { name: name.slice(0, 200) });
      if (!resp.ok) { toast.error(`Could not create album "${name}": ${await errorMessage(resp, 'error')}`); continue; }
      const album = (await resp.json()) as HostMediaAlbum;
      out.set(name, album.id);
    }
    return out;
  };

  const start = async () => {
    const pending = queue.filter((q) => q.status === 'queued' || q.status === 'failed');
    if (pending.length === 0) return;
    setRunning(true);
    pending.forEach((p) => patchItem(p.key, { status: 'queued', progress: 0, error: undefined }));

    const created = new Map<string, string>(); // queue key -> media id
    const batches = batchesOf(pending);
    let cursor = 0;

    const runBatch = async (batch: QueueItem[]) => {
      batch.forEach((b) => patchItem(b.key, { status: 'uploading' }));
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const res = await postBatch(eventId, batch.map((b) => b.file), caption.trim(), (fraction) =>
            batch.forEach((b) => patchItem(b.key, { progress: fraction })),
          );
          if (res.status === 429) {
            await new Promise((r) => setTimeout(r, res.retryAfter * 1000));
            continue;
          }
          if (res.status !== 200 && res.status !== 207) {
            batch.forEach((b) => patchItem(b.key, { status: 'failed', error: res.message ?? `HTTP ${res.status}` }));
            return;
          }
          // Results come back in request order.
          batch.forEach((b, i) => {
            const r = res.items[i];
            if (r?.status === 'created' && r.media_id) {
              created.set(b.key, r.media_id);
              patchItem(b.key, { status: 'done', progress: 1, mediaId: r.media_id });
            } else {
              patchItem(b.key, { status: 'failed', error: r?.message ?? 'Upload failed' });
            }
          });
          return;
        } catch (err) {
          if (attempt === 5) {
            batch.forEach((b) => patchItem(b.key, { status: 'failed', error: err instanceof Error ? err.message : 'Upload failed' }));
            return;
          }
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      batch.forEach((b) => patchItem(b.key, { status: 'failed', error: 'Rate limited; try again shortly' }));
    };

    const worker = async () => {
      while (cursor < batches.length) {
        const batch = batches[cursor++]!;
        await runBatch(batch);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));

    // Album membership: chosen albums get every upload; ZIP folders get their own files.
    const createdIds = Array.from(created.values());
    try {
      for (const albumId of albumIds) {
        if (createdIds.length) {
          const resp = await addManyToAlbum(HOST_KIND, eventId, albumId, createdIds);
          if (!resp.ok) toast.error(await errorMessage(resp, 'Could not add uploads to album'));
        }
      }
      if (mode === 'zip' && foldersAsAlbums) {
        const map = await folderAlbums(pending);
        for (const [folder, albumId] of map) {
          const ids = pending.filter((p) => p.folder === folder && created.has(p.key)).map((p) => created.get(p.key)!);
          if (ids.length) {
            const resp = await addManyToAlbum(HOST_KIND, eventId, albumId, ids);
            if (!resp.ok) toast.error(await errorMessage(resp, `Could not fill album "${folder}"`));
          }
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update albums');
    }

    setRunning(false);
    const failed = pending.length - created.size;
    if (failed === 0) {
      toast.success(`Uploaded ${created.size} file(s)`);
      onDone();
    } else {
      toast.warning(`Uploaded ${created.size} file(s), ${failed} failed. Fix or remove them and try again.`);
      if (created.size) onDone();
    }
  };

  const busy = running || unzipping;
  const hasFolders = queue.some((q) => q.folder);

  return (
    <Modal
      isOpen
      onClose={busy ? () => undefined : onClose}
      title="Upload media"
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--gray-a10)]">
            {queue.length > 0 && `${queue.length} file(s) · ${formatFileSize(totals.bytes)}`}
            {running && ` · ${totals.pct}%`}
            {totals.failed > 0 && !running && ` · ${totals.failed} failed`}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>{totals.done > 0 ? 'Close' : 'Cancel'}</Button>
            <Button onClick={start} disabled={busy || queue.every((q) => q.status === 'done')}>
              <ArrowUpTrayIcon className="h-4 w-4" />
              {running ? 'Uploading…' : totals.failed > 0 ? 'Retry failed' : 'Upload'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="inline-flex rounded-lg border border-[var(--gray-a6)] p-0.5">
          {(['files', 'zip'] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={busy}
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${mode === m ? 'bg-[var(--accent-9)] text-white' : 'text-[var(--gray-a11)]'}`}
            >
              {m === 'files' ? 'Photos & videos' : 'ZIP archive'}
            </button>
          ))}
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => (mode === 'files' ? fileInput.current : zipInput.current)?.click()}
          className={`cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors ${dragOver ? 'border-[var(--accent-9)] bg-[var(--accent-a2)]' : 'border-[var(--gray-a6)] hover:border-[var(--gray-a8)]'}`}
        >
          <DocumentArrowUpIcon className="mx-auto h-10 w-10 text-[var(--gray-a8)]" />
          <p className="mt-2 text-sm font-medium">
            {unzipping ? 'Reading ZIP…' : mode === 'files' ? 'Drop photos and videos here, or click to choose' : 'Drop a ZIP here, or click to choose'}
          </p>
          <p className="mt-1 text-xs text-[var(--gray-a10)]">
            {mode === 'files'
              ? 'Up to 50 MB per file. Videos go to YouTube when it is configured.'
              : 'ZIPs up to 2 GB are unpacked in your browser. Top-level folders can become albums.'}
          </p>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="image/*,video/*,audio/*"
            className="hidden"
            onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }}
          />
          <input
            ref={zipInput}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void unzip(f); e.target.value = ''; }}
          />
        </div>

        {queue.length > 0 && (
          <div className="max-h-60 space-y-1 overflow-y-auto rounded-lg border border-[var(--gray-a5)] p-2">
            {queue.map((q) => (
              <div key={q.key} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate" title={q.error ?? q.file.name}>
                  {q.folder && <span className="text-[var(--gray-a9)]">{q.folder}/</span>}
                  {q.file.name}
                </span>
                <span className="w-16 text-right text-[var(--gray-a9)]">{formatFileSize(q.file.size)}</span>
                <span className="w-24">
                  {q.status === 'uploading' ? (
                    <span className="block h-1.5 overflow-hidden rounded bg-[var(--gray-a4)]">
                      <span className="block h-full bg-[var(--accent-9)]" style={{ width: `${Math.round(q.progress * 100)}%` }} />
                    </span>
                  ) : q.status === 'done' ? (
                    <span className="text-[var(--green-11)]">Uploaded</span>
                  ) : q.status === 'failed' ? (
                    <span className="text-[var(--red-11)]" title={q.error}>Failed</span>
                  ) : (
                    <span className="text-[var(--gray-a9)]">Queued</span>
                  )}
                </span>
                {!running && q.status !== 'done' && (
                  <button type="button" title="Remove" onClick={() => setQueue((all) => all.filter((x) => x.key !== q.key))}>
                    <XMarkIcon className="h-3.5 w-3.5 text-[var(--gray-a9)]" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div>
          <label className="mb-1 block text-sm font-medium">Caption (optional, applied to every file)</label>
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            rows={2}
            maxLength={500}
            disabled={busy}
            className="w-full rounded-md border border-[var(--gray-a6)] bg-transparent px-3 py-2 text-sm"
          />
        </div>

        {albums.length > 0 && (
          <div>
            <label className="mb-1 block text-sm font-medium">Add to albums (optional)</label>
            <div className="flex flex-wrap gap-2">
              {albums.map((a) => {
                const on = albumIds.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    disabled={busy}
                    onClick={() => setAlbumIds((ids) => (on ? ids.filter((x) => x !== a.id) : [...ids, a.id]))}
                    className={`rounded-full px-3 py-1 text-xs font-medium ${on ? 'bg-[var(--accent-9)] text-white' : 'bg-[var(--gray-a3)] text-[var(--gray-a11)]'}`}
                  >
                    {a.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {mode === 'zip' && hasFolders && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={foldersAsAlbums} onChange={(e) => setFoldersAsAlbums(e.target.checked)} disabled={busy} />
            Turn ZIP folders into albums
          </label>
        )}
      </div>
    </Modal>
  );
}
