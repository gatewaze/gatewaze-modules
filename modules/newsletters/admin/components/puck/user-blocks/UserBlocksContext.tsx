/**
 * Context shared between the toolbar (My Blocks button + insert
 * picker) and the in-canvas Action Bar override (Save selection as
 * block button). Lifts the user-block list + scoped CRUD callbacks
 * into a single source of truth that both surfaces read/write.
 *
 * Mounted by `NewsletterPuckCanvas` near the top of its tree so it
 * spans both the toolbar (above Puck) and the actionBar override
 * (rendered inside `<Puck>`).
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { appendUserBlock, loadUserBlocks, removeUserBlock } from './storage.js';
import type { UserBlock } from './types.js';

export interface UserBlocksValue {
  blocks: ReadonlyArray<UserBlock>;
  /** Persist a new entry. Generates id + created_at internally. */
  saveBlock: (input: { label: string; description: string; tree: UserBlock['tree'] }) => UserBlock;
  /** Drop an entry by id. */
  deleteBlock: (id: string) => void;
  /** Open the save modal pre-populated with this tree. Tracked here so
   *  the in-canvas action bar can poke the toolbar's modal without a
   *  callback chain. */
  pendingSave: UserBlock['tree'] | null;
  requestSave: (tree: UserBlock['tree']) => void;
  clearPendingSave: () => void;
}

const Ctx = createContext<UserBlocksValue | undefined>(undefined);

export function UserBlocksProvider({
  scopeId,
  children,
}: {
  scopeId: string;
  children: ReactNode;
}) {
  const [blocks, setBlocks] = useState<UserBlock[]>(() => loadUserBlocks(scopeId));
  const [pendingSave, setPendingSave] = useState<UserBlock['tree'] | null>(null);

  const saveBlock = useCallback<UserBlocksValue['saveBlock']>(
    (input) => {
      const entry: UserBlock = {
        id: freshUuid(),
        label: input.label,
        description: input.description,
        created_at: new Date().toISOString(),
        tree: input.tree,
      };
      const next = appendUserBlock(scopeId, entry);
      setBlocks(next);
      return entry;
    },
    [scopeId],
  );

  const deleteBlock = useCallback(
    (id: string) => {
      const next = removeUserBlock(scopeId, id);
      setBlocks(next);
    },
    [scopeId],
  );

  const value = useMemo<UserBlocksValue>(
    () => ({
      blocks,
      saveBlock,
      deleteBlock,
      pendingSave,
      requestSave: setPendingSave,
      clearPendingSave: () => setPendingSave(null),
    }),
    [blocks, saveBlock, deleteBlock, pendingSave],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUserBlocks(): UserBlocksValue {
  const v = useContext(Ctx);
  if (!v) {
    return {
      blocks: [],
      saveBlock: () => ({ id: '', label: '', description: '', created_at: '', tree: { type: '', props: {} } }),
      deleteBlock: () => {},
      pendingSave: null,
      requestSave: () => {},
      clearPendingSave: () => {},
    };
  }
  return v;
}

function freshUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
