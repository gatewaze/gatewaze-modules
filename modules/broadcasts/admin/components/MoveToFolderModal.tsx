import { useMemo, useState } from 'react';
import { FolderIcon, InboxIcon, PlusIcon } from '@heroicons/react/24/outline';
import { Modal, Button } from '@/components/ui';
import { toast } from 'sonner';
import {
  createBroadcastFolder, type BroadcastFolder,
} from '../lib/broadcastService';

interface MoveToFolderModalProps {
  isOpen: boolean;
  onClose: () => void;
  broadcastName: string;
  currentFolderId: string | null;
  folders: BroadcastFolder[];
  onMove: (folderId: string | null) => Promise<void> | void;
  onFoldersChanged: () => void; // reload folders after a create
}

// Flatten the folder tree into depth-ordered rows for an indented pick list.
function flatten(folders: BroadcastFolder[]): Array<BroadcastFolder & { depth: number }> {
  const childrenOf = new Map<string | null, BroadcastFolder[]>();
  for (const f of folders) {
    const key = f.parent_id ?? null;
    (childrenOf.get(key) ?? childrenOf.set(key, []).get(key)!).push(f);
  }
  const out: Array<BroadcastFolder & { depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of (childrenOf.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ ...f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// `undefined` = nothing picked yet; `null` = unfile; string = a folder id.
type Target = string | null | undefined;

export function MoveToFolderModal({
  isOpen, onClose, broadcastName, currentFolderId, folders, onMove, onFoldersChanged,
}: MoveToFolderModalProps) {
  const rows = useMemo(() => flatten(folders), [folders]);
  const [target, setTarget] = useState<Target>(currentFolderId ?? null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const pick = (t: Target) => setTarget(t);
  const rowCls = (active: boolean) =>
    `flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md text-sm cursor-pointer ${
      active ? 'bg-[var(--accent-a3)] text-[var(--accent-11)] font-medium' : 'text-[var(--gray-12)] hover:bg-[var(--gray-a3)]'
    }`;

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      // create under the currently-picked folder (or at root)
      const parentId = typeof target === 'string' ? target : null;
      const folder = await createBroadcastFolder(name, parentId);
      setNewName('');
      onFoldersChanged();
      setTarget(folder.id);
      toast.success(`Folder “${folder.name}” created`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create folder');
    } finally {
      setBusy(false);
    }
  };

  const handleMove = async () => {
    if (target === undefined) return;
    setBusy(true);
    try {
      await onMove(target);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to move broadcast');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Move broadcast"
      size="sm"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="outlined" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="solid" onClick={handleMove} disabled={busy || target === undefined}>
            {busy ? 'Moving…' : 'Move here'}
          </Button>
        </div>
      }
    >
      <p className="text-sm text-[var(--gray-11)] mb-3">
        Move <span className="font-medium text-[var(--gray-12)]">{broadcastName}</span> to:
      </p>

      <div className="max-h-72 overflow-y-auto flex flex-col gap-0.5">
        <button type="button" className={rowCls(target === null)} onClick={() => pick(null)}>
          <InboxIcon className="size-4 shrink-0 text-[var(--gray-10)]" />
          No folder (unfiled)
        </button>
        {rows.map((f) => (
          <button
            key={f.id}
            type="button"
            className={rowCls(target === f.id)}
            style={{ paddingLeft: 8 + f.depth * 16 }}
            onClick={() => pick(f.id)}
          >
            <FolderIcon className="size-4 shrink-0 text-[var(--gray-10)]" />
            <span className="truncate">{f.name}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 pt-3 border-t border-[var(--gray-a4)]">
        <label className="block text-xs text-[var(--gray-10)] mb-1">
          New folder{typeof target === 'string' ? ' (inside the selected folder)' : ''}
        </label>
        <div className="flex items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreate(); } }}
            placeholder="Folder name"
            className="grow rounded-md border border-[var(--gray-a5)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent-8)]"
          />
          <Button variant="outlined" onClick={handleCreate} disabled={busy || !newName.trim()}>
            <PlusIcon className="size-4 mr-1" /> Create
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default MoveToFolderModal;
