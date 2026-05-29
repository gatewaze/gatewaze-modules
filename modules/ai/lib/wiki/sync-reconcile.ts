/**
 * Bidirectional sync reconciliation — the pure decision core of spec §7.
 *
 * The invariant is `git_synced_hash`: the content_hash at which the DB row and
 * the git file were last equal. A side is "dirty" iff its current hash differs
 * from git_synced_hash. From the two dirty flags (plus timestamps) we pick one
 * of a small set of actions; last-writer-wins resolves true conflicts, and the
 * loser is always preserved by the caller (§7.2). This module is pure so the
 * truth table is unit-tested without git or a DB.
 */

export interface DbRowState {
  contentHash: string;
  gitSyncedHash: string | null;
  updatedAt: string; // ISO
}

export interface PullFileState {
  gitHash: string;
  gitCommitTime: string; // ISO
  gitDeleted?: boolean;
}

export type PullAction = 'noop' | 'create' | 'accept_git' | 'db_wins_skip' | 'conflict' | 'delete';

export interface PullDecision {
  action: PullAction;
  /** For 'conflict': which side wins by last-writer-wins. */
  winner?: 'git' | 'db';
}

/** Decide what a pulled file change implies for the DB row (§7.2). */
export function decidePull(file: PullFileState, row: DbRowState | null): PullDecision {
  if (!row) {
    // Not in the DB yet.
    return file.gitDeleted ? { action: 'noop' } : { action: 'create' };
  }
  const dbDirty = row.contentHash !== row.gitSyncedHash;

  if (file.gitDeleted) {
    if (!dbDirty) return { action: 'delete' };
    // DB changed but git deleted → true conflict.
    return { action: 'conflict', winner: laterWins(file.gitCommitTime, row.updatedAt) };
  }

  if (file.gitHash === row.contentHash) return { action: 'noop' }; // already equal (loop-break)

  const gitDirty = file.gitHash !== row.gitSyncedHash;
  if (gitDirty && !dbDirty) return { action: 'accept_git' };
  if (!gitDirty && dbDirty) return { action: 'db_wins_skip' };
  if (gitDirty && dbDirty) return { action: 'conflict', winner: laterWins(file.gitCommitTime, row.updatedAt) };
  return { action: 'noop' };
}

function laterWins(gitTime: string, dbTime: string): 'git' | 'db' {
  return new Date(gitTime).getTime() > new Date(dbTime).getTime() ? 'git' : 'db';
}

export interface PushPageState {
  slug: string;
  contentHash: string;
  gitSyncedHash: string | null;
  deletedAt: string | null;
}

export interface PushPlan {
  toWrite: string[]; // slugs whose file must be (re)written
  toDelete: string[]; // slugs whose file must be git-removed (tombstoned + previously synced)
}

/** Decide which page files to write vs remove on a push (§7.1 step 5). */
export function decidePushFiles(pages: ReadonlyArray<PushPageState>): PushPlan {
  const toWrite: string[] = [];
  const toDelete: string[] = [];
  for (const p of pages) {
    if (p.deletedAt) {
      if (p.gitSyncedHash != null) toDelete.push(p.slug); // was synced → remove from git
    } else if (p.contentHash !== p.gitSyncedHash) {
      toWrite.push(p.slug); // DB-dirty → (re)write
    }
  }
  return { toWrite, toDelete };
}
