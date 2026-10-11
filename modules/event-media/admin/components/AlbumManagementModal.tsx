import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PlusIcon, PencilIcon, TrashIcon, FolderIcon, ChevronUpIcon, ChevronDownIcon, EyeIcon, EyeSlashIcon, SparklesIcon, ViewfinderCircleIcon, SunIcon, ScissorsIcon, CameraIcon } from '@heroicons/react/24/outline';
import { Button, Modal, Input, ConfirmModal } from '@/components/ui';
import { createAlbum, updateAlbum, deleteAlbum, errorMessage } from '@gatewaze-modules/host-media/admin';
import {
  HOST_KIND,
  type HostMediaAlbum,
  type AlbumSetting,
  loadAlbumSettings,
  saveAlbumSetting,
} from '../utils/mediaOrganizerService';
import { enhanceMedia, type EnhanceProgress } from '../utils/enhanceMedia';
import { aiEnhanceMedia, type AiEnhanceProgress } from '../utils/aiEnhanceMedia';

interface AlbumManagementModalProps {
  eventId: string;
  albums: HostMediaAlbum[];
  albumCounts: Map<string, number>;
  /** The photographs in one album, for enhancing them. */
  mediaIdsIn?: (albumId: string) => string[];
  onClose: () => void;
  onChanged: () => void;
  onDeleted: (albumId: string) => void;
}

export function AlbumManagementModal({ eventId, albums, albumCounts, mediaIdsIn, onClose, onChanged, onDeleted }: AlbumManagementModalProps) {
  const [editing, setEditing] = useState<HostMediaAlbum | 'new' | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<HostMediaAlbum | null>(null);
  // Per-album settings. An album with no row is shown and unenhanced,
  // so this holds only the ones an organiser has changed.
  const [settings, setSettings] = useState<Map<string, AlbumSetting>>(new Map());
  const [toggling, setToggling] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [progress, setProgress] = useState<EnhanceProgress | null>(null);
  const [aiProgress, setAiProgress] = useState<AiEnhanceProgress | null>(null);
  const stopRef = useRef(false);

  const settingFor = useCallback((id: string): AlbumSetting => (
    settings.get(id) ?? { show_on_portal: true, enhance: false, xray: false, enhance_source: 'standard' as const, frame: 'as-shot' as const, focus: 'off' as const }
  ), [settings]);

  useEffect(() => {
    let cancelled = false;
    void loadAlbumSettings(eventId).then((s) => { if (!cancelled) setSettings(s); });
    return () => { cancelled = true; stopRef.current = true; };
  }, [eventId]);

  const change = useCallback(async (album: HostMediaAlbum, patch: Partial<AlbumSetting>, said: string) => {
    const current = settingFor(album.id);
    setToggling(album.id);
    try {
      await saveAlbumSetting(eventId, album.id, patch, current);
      setSettings((prev) => new Map(prev).set(album.id, { ...current, ...patch }));
      toast.success(said);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not change that');
    } finally {
      setToggling(null);
    }
  }, [eventId, settingFor]);

  /**
   * Walk the album, improving what needs it. A photograph already looked
   * at is left alone by the server, so this can be run again after more
   * photographs arrive without paying for the ones already done.
   */
  const runEnhance = useCallback(async (album: HostMediaAlbum, force = false) => {
    const ids = mediaIdsIn ? mediaIdsIn(album.id) : [];
    if (ids.length === 0) { toast.error('There are no photos in that album yet'); return; }
    stopRef.current = false;
    setRunning(album.id);
    setProgress({ done: 0, total: ids.length, enhanced: 0, unchanged: 0, failed: 0 });
    try {
      const done = await enhanceMedia(eventId, ids, setProgress, () => !stopRef.current, 'media', force, settingFor(album.id).frame, settingFor(album.id).focus);
      toast.success(`${done.enhanced} improved, ${done.unchanged} already good${done.failed ? `, ${done.failed} could not be done` : ''}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The enhancement stopped');
    } finally {
      setRunning(null);
    }
  }, [eventId, mediaIdsIn, onChanged]);

  /**
   * Walk the album, relighting it with the model. Paid per photograph,
   * so one already relit is left alone unless Redo is used, and the
   * count is said out loud before anything is spent.
   */
  const runAiEnhance = useCallback(async (album: HostMediaAlbum, force = false) => {
    const ids = mediaIdsIn ? mediaIdsIn(album.id) : [];
    if (ids.length === 0) { toast.error('There are no photos in that album yet'); return; }
    stopRef.current = false;
    setRunning(album.id);
    setAiProgress({ done: 0, total: ids.length, relit: 0, skipped: 0, failed: 0 });
    try {
      const done = await aiEnhanceMedia(eventId, ids, setAiProgress, () => !stopRef.current, 'media', force, settingFor(album.id).frame, settingFor(album.id).focus);
      toast.success(`${done.relit} relit, ${done.skipped} already done${done.failed ? `, ${done.failed} could not be done` : ''}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The relighting stopped');
    } finally {
      setRunning(null);
      setAiProgress(null);
    }
  }, [eventId, mediaIdsIn, onChanged, settingFor]);

  const openForm = (album: HostMediaAlbum | 'new') => {
    setEditing(album);
    setName(album === 'new' ? '' : album.name);
    setDescription(album === 'new' ? '' : album.description ?? '');
  };

  const save = async () => {
    if (!name.trim()) { toast.error('Album name is required'); return; }
    setSaving(true);
    try {
      const body = { name: name.trim(), description: description.trim() || null };
      const resp = editing === 'new'
        ? await createAlbum(HOST_KIND, eventId, { name: body.name, description: body.description ?? undefined })
        : await updateAlbum(HOST_KIND, eventId, (editing as HostMediaAlbum).id, body);
      if (!resp.ok) throw new Error(await errorMessage(resp, 'Failed to save album'));
      toast.success(editing === 'new' ? 'Album created' : 'Album updated');
      setEditing(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save album');
    } finally {
      setSaving(false);
    }
  };

  // Albums are listed by sort_order; moving one rewrites every album's
  // position so the order stays dense.
  const move = async (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= albums.length) return;
    const next = [...albums];
    [next[index], next[target]] = [next[target]!, next[index]!];
    try {
      const results = await Promise.all(
        next.map((a, i) => (a.sort_order === (i + 1) * 10 ? null : updateAlbum(HOST_KIND, eventId, a.id, { sort_order: (i + 1) * 10 }))),
      );
      if (results.some((r) => r && !r.ok)) throw new Error('Failed to reorder albums');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reorder albums');
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    const album = confirmDelete;
    setConfirmDelete(null);
    try {
      const resp = await deleteAlbum(HOST_KIND, eventId, album.id);
      if (resp.status !== 204) throw new Error(await errorMessage(resp, 'Failed to delete album'));
      toast.success('Album deleted');
      onDeleted(album.id);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete album');
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Manage albums"
      size="md"
      footer={<div className="flex justify-end"><Button variant="outline" onClick={onClose}>Close</Button></div>}
    >
      <div className="space-y-4">
        {editing ? (
          <div className="space-y-3 rounded-lg border border-[var(--gray-a5)] bg-[var(--gray-a2)] p-4">
            <h3 className="text-sm font-medium">{editing === 'new' ? 'New album' : 'Edit album'}</h3>
            <div>
              <label className="mb-1 block text-sm font-medium">Name <span className="text-[var(--red-11)]">*</span></label>
              <Input
                value={name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                placeholder="Album name"
                maxLength={200}
                disabled={saving}
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Description (optional)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                maxLength={2000}
                disabled={saving}
                className="w-full rounded-md border border-[var(--gray-a6)] bg-transparent px-3 py-2 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button>
              <Button size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : editing === 'new' ? 'Create' : 'Update'}</Button>
            </div>
          </div>
        ) : (
          <Button onClick={() => openForm('new')} className="w-full">
            <PlusIcon className="h-4 w-4" /> Add new album
          </Button>
        )}

        {albums.length === 0 ? (
          <div className="py-10 text-center">
            <FolderIcon className="mx-auto h-12 w-12 text-[var(--gray-a8)]" />
            <p className="mt-3 text-sm text-[var(--gray-a10)]">No albums yet. Create one to organize this event's media.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {albums.map((album, i) => (
              <div key={album.id} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--gray-a5)] p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <FolderIcon className="h-5 w-5 shrink-0 text-[var(--accent-11)]" />
                    <span className="truncate font-medium">{album.name}</span>
                    <span className="shrink-0 text-xs text-[var(--gray-a9)]">({albumCounts.get(album.id) ?? 0} items)</span>
                  </div>
                  {album.description && <p className="mt-1 text-sm text-[var(--gray-a10)]">{album.description}</p>}
                  <p className="mt-1 text-xs text-[var(--gray-a9)]">
                    {settingFor(album.id).show_on_portal ? 'Shown on the portal' : 'Not shown on the portal'}
                    {settingFor(album.id).enhance
                      ? (settingFor(album.id).enhance_source === 'ai' ? ' · relit' : ' · enhanced')
                      : ''}
                    {settingFor(album.id).xray ? ' · selfies shown' : ''}
                    {settingFor(album.id).frame === 'classic' ? ' · 3:2'
                      : settingFor(album.id).frame === 'expand' ? ' · 3:2 expanded' : ''}
                    {settingFor(album.id).focus !== 'off' ? ` · ${settingFor(album.id).focus} focus` : ''}
                    {running === album.id && aiProgress
                      ? ` · relighting ${aiProgress.done} of ${aiProgress.total}…`
                      : running === album.id && progress
                        ? ` · improving ${progress.done} of ${progress.total}…`
                        : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    title={settingFor(album.id).show_on_portal ? 'Shown on the portal — click to hide it' : 'Hidden from the portal — click to show it'}
                    disabled={toggling === album.id}
                    onClick={() => void change(
                      album,
                      { show_on_portal: !settingFor(album.id).show_on_portal },
                      settingFor(album.id).show_on_portal ? `"${album.name}" is hidden from the portal` : `"${album.name}" is on the portal`,
                    )}
                    className={`rounded p-1 hover:bg-[var(--gray-a3)] disabled:opacity-30 ${
                      settingFor(album.id).show_on_portal ? 'text-[var(--accent-11)]' : 'text-[var(--gray-a8)]'
                    }`}
                  >
                    {settingFor(album.id).show_on_portal ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                  </button>
                  <button
                    type="button"
                    title={settingFor(album.id).enhance
                      ? 'Enhanced copies are shown on the portal — click to show the originals'
                      : 'Show enhanced copies on the portal (the originals are kept either way)'}
                    disabled={toggling === album.id}
                    onClick={() => void change(
                      album,
                      { enhance: !settingFor(album.id).enhance },
                      settingFor(album.id).enhance
                        ? `"${album.name}" shows the original photos`
                        : `"${album.name}" shows enhanced photos where there are any`,
                    )}
                    className={`rounded p-1 hover:bg-[var(--gray-a3)] disabled:opacity-30 ${
                      settingFor(album.id).enhance ? 'text-[var(--accent-11)]' : 'text-[var(--gray-a8)]'
                    }`}
                  >
                    <SparklesIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    title={settingFor(album.id).xray
                      ? 'Guests can see the selfies behind these pictures — click to hide them'
                      : 'Let guests see the selfies behind these pictures'}
                    disabled={toggling === album.id}
                    onClick={() => void change(
                      album,
                      { xray: !settingFor(album.id).xray },
                      settingFor(album.id).xray
                        ? `The selfies behind "${album.name}" are hidden`
                        : `Guests can see the selfies behind "${album.name}"`,
                    )}
                    className={`rounded p-1 hover:bg-[var(--gray-a3)] disabled:opacity-30 ${
                      settingFor(album.id).xray ? 'text-[var(--accent-11)]' : 'text-[var(--gray-a8)]'
                    }`}
                  >
                    <ViewfinderCircleIcon className="h-4 w-4" />
                  </button>
                  {mediaIdsIn && (
                    <button
                      type="button"
                      title="Look at every photo in this album and improve the ones that need it"
                      disabled={running !== null}
                      onClick={() => (running === album.id ? (stopRef.current = true) : void runEnhance(album))}
                      className="rounded px-2 py-1 text-xs text-[var(--gray-a10)] hover:bg-[var(--gray-a3)] disabled:opacity-30"
                    >
                      {running === album.id ? 'Stop' : 'Improve'}
                    </button>
                  )}
                  {mediaIdsIn && running === null && (
                    <button
                      type="button"
                      title="Look at every photo again and remake the improved copies, even the ones already done"
                      onClick={() => void runEnhance(album, true)}
                      className="rounded px-2 py-1 text-xs text-[var(--gray-a10)] hover:bg-[var(--gray-a3)]"
                    >
                      Redo
                    </button>
                  )}
                  {mediaIdsIn && running === null && (
                    <button
                      type="button"
                      title="Relight every photo in this album with the model. Costs a few pence per photo, and it redraws them — the originals are kept."
                      onClick={() => void runAiEnhance(album)}
                      className="rounded px-2 py-1 text-xs text-[var(--gray-a10)] hover:bg-[var(--gray-a3)]"
                    >
                      Relight
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={toggling === album.id || !settingFor(album.id).enhance}
                    title={!settingFor(album.id).enhance
                      ? 'Turn improved copies on first'
                      : settingFor(album.id).enhance_source === 'ai'
                        ? 'Showing the model\'s relit copies — click to show the arithmetic ones'
                        : 'Showing the arithmetic copies — click to show the model\'s relit ones where they exist'}
                    onClick={() => void change(
                      album,
                      { enhance_source: settingFor(album.id).enhance_source === 'ai' ? 'standard' : 'ai' },
                      settingFor(album.id).enhance_source === 'ai'
                        ? `"${album.name}" shows the arithmetic copies`
                        : `"${album.name}" shows the relit copies where there are any`,
                    )}
                    className={`rounded p-1 hover:bg-[var(--gray-a3)] disabled:opacity-30 ${
                      settingFor(album.id).enhance_source === 'ai' ? 'text-[var(--accent-11)]' : 'text-[var(--gray-a8)]'
                    }`}
                  >
                    <SunIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    disabled={toggling === album.id}
                    title={settingFor(album.id).frame === 'as-shot'
                      ? 'Delivered as the phone framed it — click to crop to 3:2'
                      : settingFor(album.id).frame === 'classic'
                        ? 'Cropped to 3:2 — click to expand to it instead, which costs a few pence a photo'
                        : 'Expanded to 3:2 by a model drawing outside the frame — click to leave the shape alone'}
                    onClick={() => {
                      const now = settingFor(album.id).frame;
                      const next = now === 'as-shot' ? 'classic' : now === 'classic' ? 'expand' : 'as-shot';
                      void change(
                        album,
                        { frame: next },
                        next === 'as-shot' ? `"${album.name}" keeps the shape it was taken in`
                          : next === 'classic' ? `"${album.name}" is cropped to 3:2`
                            : `"${album.name}" is expanded to 3:2`,
                      );
                    }}
                    className={`rounded p-1 hover:bg-[var(--gray-a3)] disabled:opacity-30 ${
                      settingFor(album.id).frame === 'as-shot' ? 'text-[var(--gray-a8)]' : 'text-[var(--accent-11)]'
                    }`}
                  >
                    <ScissorsIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    disabled={toggling === album.id}
                    title={settingFor(album.id).focus === 'off'
                      ? 'Everything sharp, as the phone saw it — click for a little depth of field'
                      : `Depth of field: ${settingFor(album.id).focus} — click to change it`}
                    onClick={() => {
                      const order = ['off', 'gentle', 'medium', 'strong'] as const;
                      const now = settingFor(album.id).focus;
                      const next = order[(order.indexOf(now) + 1) % order.length]!;
                      void change(
                        album,
                        { focus: next },
                        next === 'off'
                          ? `"${album.name}" keeps everything sharp`
                          : `"${album.name}" has ${next} depth of field`,
                      );
                    }}
                    className={`rounded p-1 hover:bg-[var(--gray-a3)] disabled:opacity-30 ${
                      settingFor(album.id).focus === 'off' ? 'text-[var(--gray-a8)]' : 'text-[var(--accent-11)]'
                    }`}
                  >
                    <CameraIcon className="h-4 w-4" />
                  </button>
                  <button type="button" title="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1 text-[var(--gray-a10)] hover:bg-[var(--gray-a3)] disabled:opacity-30">
                    <ChevronUpIcon className="h-4 w-4" />
                  </button>
                  <button type="button" title="Move down" disabled={i === albums.length - 1} onClick={() => move(i, 1)} className="rounded p-1 text-[var(--gray-a10)] hover:bg-[var(--gray-a3)] disabled:opacity-30">
                    <ChevronDownIcon className="h-4 w-4" />
                  </button>
                  <button type="button" title="Edit album" onClick={() => openForm(album)} className="rounded p-1 text-[var(--gray-a10)] hover:bg-[var(--gray-a3)]">
                    <PencilIcon className="h-4 w-4" />
                  </button>
                  <button type="button" title="Delete album" onClick={() => setConfirmDelete(album)} className="rounded p-1 text-[var(--gray-a10)] hover:bg-[var(--red-a3)] hover:text-[var(--red-11)]">
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {confirmDelete && (
        <ConfirmModal
          isOpen
          onClose={() => setConfirmDelete(null)}
          onConfirm={doDelete}
          title="Delete album?"
          message={`Delete the album "${confirmDelete.name}"? The media in it will not be deleted.`}
          confirmText="Delete"
          confirmColor="red"
        />
      )}
    </Modal>
  );
}
