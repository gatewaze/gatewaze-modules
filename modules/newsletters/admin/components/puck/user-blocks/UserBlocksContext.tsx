/**
 * Context shared between the toolbar (My Blocks button + insert
 * picker) and the in-canvas Action Bar override (Save selection as
 * block button). Lifts the user-block list + scoped CRUD callbacks
 * into a single source of truth that both surfaces read/write.
 *
 * Mounted by `NewsletterPuckCanvas` near the top of its tree so it
 * spans both the toolbar (above Puck) and the actionBar override
 * (rendered inside `<Puck>`).
 *
 * Storage is DB-backed via `storage.ts` — newsletter collections'
 * `metadata.user_blocks` JSON column. The provider does an async
 * initial load on mount and tracks the load state so consumers can
 * show a spinner / empty placeholder until the round-trip completes.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { appendUserBlock, loadUserBlocks, removeUserBlock } from './storage.js';
import type { UserBlock } from './types.js';

export type UserBlocksLoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface UserBlocksValue {
  blocks: ReadonlyArray<UserBlock>;
  loadState: UserBlocksLoadState;
  loadError: string | null;
  /** Persist a new entry. Generates id + created_at internally; resolves with the row. */
  saveBlock: (input: { label: string; description: string; tree: UserBlock['tree'] }) => Promise<UserBlock>;
  /** Drop an entry by id. Resolves once the DB write completes. */
  deleteBlock: (id: string) => Promise<void>;
  /** Open the save modal pre-populated with this tree. Tracked here so
   *  the in-canvas action bar can poke the toolbar's modal without a
   *  callback chain. */
  pendingSave: UserBlock['tree'] | null;
  requestSave: (tree: UserBlock['tree']) => void;
  clearPendingSave: () => void;
  /** Force a re-fetch (e.g. after another tab modified the row). */
  refresh: () => Promise<void>;
}

const Ctx = createContext<UserBlocksValue | undefined>(undefined);

export function UserBlocksProvider({
  scopeId,
  children,
}: {
  scopeId: string;
  children: ReactNode;
}) {
  const [blocks, setBlocks] = useState<UserBlock[]>([]);
  const [pendingSave, setPendingSave] = useState<UserBlock['tree'] | null>(null);
  const [loadState, setLoadState] = useState<UserBlocksLoadState>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!scopeId) {
      setBlocks([]);
      setLoadState('ready');
      return;
    }
    setLoadState('loading');
    setLoadError(null);
    try {
      const next = await loadUserBlocks(scopeId);
      setBlocks(next);
      setLoadState('ready');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[user-blocks] load failed:', e);
      setLoadError(e instanceof Error ? e.message : String(e));
      setLoadState('error');
    }
  }, [scopeId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveBlock = useCallback<UserBlocksValue['saveBlock']>(
    async (input) => {
      const entry: UserBlock = {
        id: freshUuid(),
        label: input.label,
        description: input.description,
        created_at: new Date().toISOString(),
        tree: input.tree,
      };
      const next = await appendUserBlock(scopeId, entry);
      setBlocks(next);
      return entry;
    },
    [scopeId],
  );

  const deleteBlock = useCallback(
    async (id: string) => {
      const next = await removeUserBlock(scopeId, id);
      setBlocks(next);
    },
    [scopeId],
  );

  const value = useMemo<UserBlocksValue>(
    () => ({
      blocks,
      loadState,
      loadError,
      saveBlock,
      deleteBlock,
      pendingSave,
      requestSave: setPendingSave,
      clearPendingSave: () => setPendingSave(null),
      refresh,
    }),
    [blocks, loadState, loadError, saveBlock, deleteBlock, pendingSave, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUserBlocks(): UserBlocksValue {
  const v = useContext(Ctx);
  if (!v) {
    return {
      blocks: [],
      loadState: 'idle',
      loadError: null,
      saveBlock: async () => ({ id: '', label: '', description: '', created_at: '', tree: { type: '', props: {} } }),
      deleteBlock: async () => {},
      pendingSave: null,
      requestSave: () => {},
      clearPendingSave: () => {},
      refresh: async () => {},
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
