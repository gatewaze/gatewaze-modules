import { useState } from 'react';
import { toast } from 'sonner';
import { PlusIcon, PencilIcon, TrashIcon, FolderIcon, ChevronUpIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import { Button, Modal, Input, ConfirmModal } from '@/components/ui';
import { createAlbum, updateAlbum, deleteAlbum, errorMessage } from '@gatewaze-modules/host-media/admin';
import { HOST_KIND, type HostMediaAlbum } from '../utils/mediaOrganizerService';

interface AlbumManagementModalProps {
  eventId: string;
  albums: HostMediaAlbum[];
  albumCounts: Map<string, number>;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: (albumId: string) => void;
}

export function AlbumManagementModal({ eventId, albums, albumCounts, onClose, onChanged, onDeleted }: AlbumManagementModalProps) {
  const [editing, setEditing] = useState<HostMediaAlbum | 'new' | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<HostMediaAlbum | null>(null);

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
                </div>
                <div className="flex shrink-0 gap-1">
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
