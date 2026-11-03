import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Modal, Input } from '@/components/ui';
import { addManyToAlbum, createAlbum, errorMessage } from '@gatewaze-modules/host-media/admin';
import { HOST_KIND, type HostMediaAlbum } from '../utils/mediaOrganizerService';

interface AddToAlbumModalProps {
  eventId: string;
  albums: HostMediaAlbum[];
  albumCounts: Map<string, number>;
  selectedMediaIds: string[];
  onClose: () => void;
  onSuccess: () => void;
}

export function AddToAlbumModal({ eventId, albums, albumCounts, selectedMediaIds, onClose, onSuccess }: AddToAlbumModalProps) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [newAlbumName, setNewAlbumName] = useState('');
  const [saving, setSaving] = useState(false);

  const sorted = [...albums].sort((a, b) => a.name.localeCompare(b.name));
  const canSubmit = chosen.length > 0 || newAlbumName.trim().length > 0;

  const toggle = (id: string) =>
    setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const targets = [...chosen];
      if (newAlbumName.trim()) {
        const resp = await createAlbum(HOST_KIND, eventId, { name: newAlbumName.trim() });
        if (!resp.ok) throw new Error(await errorMessage(resp, 'Could not create album'));
        const album = (await resp.json()) as HostMediaAlbum;
        targets.push(album.id);
      }
      for (const albumId of targets) {
        const resp = await addManyToAlbum(HOST_KIND, eventId, albumId, selectedMediaIds);
        if (!resp.ok) throw new Error(await errorMessage(resp, 'Could not add to album'));
      }
      toast.success(`Added ${selectedMediaIds.length} item(s) to ${targets.length} album(s)`);
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add media to albums');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Add to albums"
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !canSubmit}>{saving ? 'Adding…' : 'Add to albums'}</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-[var(--gray-a11)]">
          Choose albums for the {selectedMediaIds.length} selected item(s):
        </p>
        {sorted.length > 0 && (
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {sorted.map((album) => (
              <label
                key={album.id}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--gray-a5)] p-3 hover:bg-[var(--gray-a2)]"
              >
                <input type="checkbox" checked={chosen.includes(album.id)} onChange={() => toggle(album.id)} className="h-4 w-4" />
                <div className="flex-1">
                  <div className="font-medium">{album.name}</div>
                  {album.description && <div className="text-sm text-[var(--gray-a10)]">{album.description}</div>}
                  <div className="text-xs text-[var(--gray-a9)]">{albumCounts.get(album.id) ?? 0} items</div>
                </div>
              </label>
            ))}
          </div>
        )}
        <div>
          <label className="mb-1 block text-sm font-medium">{sorted.length > 0 ? 'Or create a new album' : 'New album'}</label>
          <Input
            value={newAlbumName}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewAlbumName(e.target.value)}
            placeholder="Album name"
            maxLength={200}
            disabled={saving}
          />
        </div>
      </div>
    </Modal>
  );
}
