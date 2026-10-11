import { useMemo, useState } from 'react';
import {
  ChevronRightIcon, ChevronDownIcon, FolderIcon, FolderOpenIcon,
  InboxIcon, PlusIcon, PencilSquareIcon, TrashIcon, FolderPlusIcon,
} from '@heroicons/react/24/outline';
import { RowActions } from '@/components/shared/table/RowActions';
import type { BroadcastFolder } from '../lib/broadcastService';

/** null = All broadcasts · UNFILED = broadcasts in no folder · else a folder id. */
export const UNFILED = '__unfiled__';
export type FolderSelection = string | null;

interface FolderSidebarProps {
  folders: BroadcastFolder[];
  selected: FolderSelection;
  onSelect: (sel: FolderSelection) => void;
  /** direct broadcast counts by folder id; `null` key not used here. */
  directCounts: Record<string, number>;
  unfiledCount: number;
  totalCount: number;
  organizeMode: boolean;
  onDropBroadcast: (broadcastId: string, folderId: string | null) => void;
  onCreateFolder: (parentId: string | null) => void;
  onRenameFolder: (folder: BroadcastFolder) => void;
  onDeleteFolder: (folder: BroadcastFolder) => void;
}

interface TreeNode extends BroadcastFolder { children: TreeNode[] }

function buildTree(folders: BroadcastFolder[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  folders.forEach((f) => byId.set(f.id, { ...f, children: [] }));
  const roots: TreeNode[] = [];
  byId.forEach((node) => {
    const parent = node.parent_id ? byId.get(node.parent_id) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  });
  return roots;
}

export function FolderSidebar({
  folders, selected, onSelect, directCounts, unfiledCount, totalCount,
  organizeMode, onDropBroadcast, onCreateFolder, onRenameFolder, onDeleteFolder,
}: FolderSidebarProps) {
  const tree = useMemo(() => buildTree(folders), [folders]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dragOver, setDragOver] = useState<string | null>(null); // folder id or UNFILED

  // subtree count = own direct count + every descendant's direct count
  const subtreeCount = useMemo(() => {
    const memo = new Map<string, number>();
    const walk = (n: TreeNode): number => {
      if (memo.has(n.id)) return memo.get(n.id)!;
      let c = directCounts[n.id] ?? 0;
      for (const ch of n.children) c += walk(ch);
      memo.set(n.id, c);
      return c;
    };
    tree.forEach(walk);
    return memo;
  }, [tree, directCounts]);

  const dropHandlers = (targetId: string, folderId: string | null) =>
    organizeMode
      ? {
          onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOver !== targetId) setDragOver(targetId); },
          onDragLeave: () => setDragOver((cur) => (cur === targetId ? null : cur)),
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            setDragOver(null);
            const id = e.dataTransfer.getData('text/broadcast-id');
            if (id) onDropBroadcast(id, folderId);
          },
        }
      : {};

  const rowBase = 'group flex items-center gap-1.5 pr-1.5 rounded-md text-sm cursor-pointer select-none transition-colors';
  const activeCls = 'bg-[var(--accent-a3)] text-[var(--accent-11)] font-medium';
  const idleCls = 'text-[var(--gray-12)] hover:bg-[var(--gray-a3)]';
  const dropCls = 'ring-1 ring-[var(--accent-8)] bg-[var(--accent-a3)]';

  const renderNode = (node: TreeNode, depth: number) => {
    const hasChildren = node.children.length > 0;
    const isOpen = expanded[node.id] ?? false;
    const isActive = selected === node.id;
    const isDrop = dragOver === node.id;
    const count = subtreeCount.get(node.id) ?? 0;
    return (
      <div key={node.id}>
        <div
          className={`${rowBase} ${isActive ? activeCls : idleCls} ${isDrop ? dropCls : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => onSelect(node.id)}
          {...dropHandlers(node.id, node.id)}
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (hasChildren) setExpanded((s) => ({ ...s, [node.id]: !isOpen })); }}
            className={`shrink-0 p-0.5 ${hasChildren ? 'text-[var(--gray-10)] hover:text-[var(--gray-12)]' : 'invisible'}`}
            aria-label={isOpen ? 'Collapse' : 'Expand'}
          >
            {isOpen ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
          </button>
          {isOpen && hasChildren ? <FolderOpenIcon className="size-4 shrink-0 text-[var(--gray-10)]" /> : <FolderIcon className="size-4 shrink-0 text-[var(--gray-10)]" />}
          <span className="grow truncate py-1.5">{node.name}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-[var(--gray-10)]">{count || ''}</span>
          <span className="shrink-0 opacity-0 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
            <RowActions
              actions={[
                { label: 'New subfolder', icon: <FolderPlusIcon className="size-4" />, onClick: () => onCreateFolder(node.id) },
                { label: 'Rename', icon: <PencilSquareIcon className="size-4" />, onClick: () => onRenameFolder(node) },
                { label: 'Delete', icon: <TrashIcon className="size-4" />, onClick: () => onDeleteFolder(node), color: 'red' },
              ]}
            />
          </span>
        </div>
        {isOpen && hasChildren && node.children.map((ch) => renderNode(ch, depth + 1))}
      </div>
    );
  };

  return (
    <div className="w-60 shrink-0 flex flex-col gap-1 pr-3 border-r border-[var(--gray-a4)]">
      {/* All broadcasts */}
      <div
        className={`${rowBase} ${selected === null ? activeCls : idleCls}`}
        style={{ paddingLeft: 8 }}
        onClick={() => onSelect(null)}
      >
        <InboxIcon className="size-4 shrink-0 text-[var(--gray-10)]" />
        <span className="grow truncate py-1.5">All broadcasts</span>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--gray-10)]">{totalCount || ''}</span>
      </div>

      <div className="flex flex-col">
        {tree.map((n) => renderNode(n, 0))}
      </div>

      {/* Unfiled */}
      <div
        className={`${rowBase} ${selected === UNFILED ? activeCls : idleCls} ${dragOver === UNFILED ? dropCls : ''}`}
        style={{ paddingLeft: 8 }}
        onClick={() => onSelect(UNFILED)}
        {...dropHandlers(UNFILED, null)}
      >
        <FolderIcon className="size-4 shrink-0 text-[var(--gray-9)]" />
        <span className="grow truncate py-1.5 text-[var(--gray-11)]">Unfiled</span>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--gray-10)]">{unfiledCount || ''}</span>
      </div>

      <button
        type="button"
        onClick={() => onCreateFolder(null)}
        className="mt-1 flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm text-[var(--accent-11)] hover:bg-[var(--accent-a3)] transition-colors"
      >
        <PlusIcon className="size-4" /> New folder
      </button>
    </div>
  );
}

export default FolderSidebar;
