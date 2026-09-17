import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { PlusIcon, PaperAirplaneIcon, Squares2X2Icon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Button, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import {
  listBroadcasts, listBroadcastFolders, createBroadcastFolder, renameBroadcastFolder,
  deleteBroadcastFolder, moveBroadcastToFolder,
  type Broadcast, type BroadcastFolder,
} from '../lib/broadcastService';
import { BroadcastsTable } from '../components/BroadcastsTable';
import { FolderSidebar, UNFILED, type FolderSelection } from '../components/FolderSidebar';

export default function BroadcastListPage() {
  const navigate = useNavigate();
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [folders, setFolders] = useState<BroadcastFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<FolderSelection>(null);
  const [organizeMode, setOrganizeMode] = useState(false);

  const load = useCallback(async () => {
    try {
      const [bs, fs] = await Promise.all([listBroadcasts(), listBroadcastFolders()]);
      setBroadcasts(bs);
      setFolders(fs);
    } catch (err) {
      console.error('Error loading broadcasts:', err);
      toast.error('Failed to load broadcasts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // folder tree helpers — descendants of a folder (inclusive) for subtree filtering
  const descendantsOf = useCallback((folderId: string): Set<string> => {
    const childrenMap = new Map<string, string[]>();
    for (const f of folders) {
      if (!f.parent_id) continue;
      (childrenMap.get(f.parent_id) ?? childrenMap.set(f.parent_id, []).get(f.parent_id)!).push(f.id);
    }
    const out = new Set<string>([folderId]);
    const stack = [folderId];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const ch of childrenMap.get(cur) ?? []) { if (!out.has(ch)) { out.add(ch); stack.push(ch); } }
    }
    return out;
  }, [folders]);

  const filtered = useMemo(() => {
    if (selected === null) return broadcasts;
    if (selected === UNFILED) return broadcasts.filter((b) => !b.folder_id);
    const subtree = descendantsOf(selected);
    return broadcasts.filter((b) => b.folder_id && subtree.has(b.folder_id));
  }, [broadcasts, selected, descendantsOf]);

  const { directCounts, unfiledCount } = useMemo(() => {
    const counts: Record<string, number> = {};
    let unfiled = 0;
    for (const b of broadcasts) {
      if (b.folder_id) counts[b.folder_id] = (counts[b.folder_id] ?? 0) + 1;
      else unfiled += 1;
    }
    return { directCounts: counts, unfiledCount: unfiled };
  }, [broadcasts]);

  // folder CRUD (lightweight prompt/confirm; the Move modal is the polished path)
  const handleCreateFolder = useCallback(async (parentId: string | null) => {
    const name = window.prompt(parentId ? 'New subfolder name' : 'New folder name');
    if (!name?.trim()) return;
    try { await createBroadcastFolder(name, parentId); await load(); toast.success('Folder created'); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to create folder'); }
  }, [load]);

  const handleRenameFolder = useCallback(async (folder: BroadcastFolder) => {
    const name = window.prompt('Rename folder', folder.name);
    if (!name?.trim() || name.trim() === folder.name) return;
    try { await renameBroadcastFolder(folder.id, name); await load(); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to rename folder'); }
  }, [load]);

  const handleDeleteFolder = useCallback(async (folder: BroadcastFolder) => {
    if (!window.confirm(`Delete folder “${folder.name}”? Its broadcasts become unfiled and any subfolders move to the top level. Broadcasts are not deleted.`)) return;
    try {
      await deleteBroadcastFolder(folder.id);
      setSelected((cur) => (cur === folder.id ? null : cur));
      await load();
      toast.success('Folder deleted');
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to delete folder'); }
  }, [load]);

  const handleDropBroadcast = useCallback(async (broadcastId: string, folderId: string | null) => {
    try { await moveBroadcastToFolder(broadcastId, folderId); await load(); toast.success('Broadcast moved'); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to move broadcast'); }
  }, [load]);

  const actions = (
    <div className="flex items-center gap-2">
      <Button variant={organizeMode ? 'solid' : 'outlined'} onClick={() => setOrganizeMode((v) => !v)}>
        <Squares2X2Icon className="h-4 w-4 mr-1" /> {organizeMode ? 'Done organizing' : 'Organize'}
      </Button>
      <Button variant="solid" onClick={() => navigate('/broadcasts/new')}>
        <PlusIcon className="h-4 w-4 mr-1" /> New Broadcast
      </Button>
    </div>
  );

  return (
    <Page title="Broadcasts">
      <WorkspaceLayout title="Broadcasts" actions={actions}>
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" />
          </div>
        ) : broadcasts.length === 0 && folders.length === 0 ? (
          <div className="text-center py-16">
            <PaperAirplaneIcon className="h-16 w-16 text-[var(--gray-8)] mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-[var(--gray-12)] mb-2">No broadcasts yet</h2>
            <p className="text-[var(--gray-11)] mb-6 max-w-md mx-auto">
              Send a single email to a segment of your audience, scheduled and timezone-aware. Build
              the audience with plain language using the AI copilot.
            </p>
            <Button variant="solid" onClick={() => navigate('/broadcasts/new')}>
              <PlusIcon className="h-4 w-4 mr-1" /> Create Your First Broadcast
            </Button>
          </div>
        ) : (
          <div className="flex gap-4 items-start">
            <FolderSidebar
              folders={folders}
              selected={selected}
              onSelect={setSelected}
              directCounts={directCounts}
              unfiledCount={unfiledCount}
              totalCount={broadcasts.length}
              organizeMode={organizeMode}
              onDropBroadcast={handleDropBroadcast}
              onCreateFolder={handleCreateFolder}
              onRenameFolder={handleRenameFolder}
              onDeleteFolder={handleDeleteFolder}
            />
            <div className="grow min-w-0">
              {organizeMode && (
                <div className="mb-3 rounded-md border border-[var(--accent-a5)] bg-[var(--accent-a2)] px-3 py-2 text-xs text-[var(--accent-11)]">
                  Organizing — drag a broadcast row onto a folder to move it. Or use the row menu → Move to folder.
                </div>
              )}
              <BroadcastsTable
                broadcasts={filtered}
                folders={folders}
                organizeMode={organizeMode}
                onChanged={load}
              />
            </div>
          </div>
        )}
      </WorkspaceLayout>
    </Page>
  );
}
