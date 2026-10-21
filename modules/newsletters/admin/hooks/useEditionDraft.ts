/**
 * Local (browser) draft persistence for a newsletter edition — the guarantee
 * that in-progress edits survive a session expiry (or an accidental reload/tab
 * close). The edition state is mirrored to localStorage as it changes; if a
 * save can't reach the server (e.g. the auth session died — see Steve's
 * 2026-07-22 incident), the work is still here and is offered back on reload.
 *
 * Semantics:
 *   - writeDraft on change (debounced by the caller).
 *   - clearDraft on every SUCCESSFUL server save — so a draft existing on load
 *     means the last edits were NOT persisted (the recovery case).
 *   - readDraft on load; if it differs from the freshly-loaded server state,
 *     the editor offers to restore it.
 *
 * Pure module functions (no React) so they're trivially testable; the caller
 * owns the debounce + when-to-prompt logic. All access is guarded so SSR / a
 * blocked localStorage never throws.
 */

const KEY_PREFIX = 'nl-edition-draft:v1:';
const key = (editionId: string) => `${KEY_PREFIX}${editionId}`;

/** The serialisable slice of an edition we persist. */
export interface EditionDraftPayload {
  subject: string;
  preheader: string;
  edition_date: string;
  blocks: unknown[];
}

export interface StoredDraft {
  savedAt: number; // client epoch ms
  payload: EditionDraftPayload;
}

function safeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null; // access blocked (privacy mode / iframe)
  }
}

export function writeDraft(editionId: string, payload: EditionDraftPayload, now: number): void {
  const ls = safeLocalStorage();
  if (!ls || !editionId || editionId === 'new') return;
  try {
    ls.setItem(key(editionId), JSON.stringify({ savedAt: now, payload } satisfies StoredDraft));
  } catch {
    // Quota exceeded or serialisation issue — non-fatal; the server remains the
    // source of truth. Better to keep editing than to throw here.
  }
}

export function readDraft(editionId: string): StoredDraft | null {
  const ls = safeLocalStorage();
  if (!ls || !editionId) return null;
  try {
    const raw = ls.getItem(key(editionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft;
    if (!parsed || typeof parsed.savedAt !== 'number' || !parsed.payload) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearDraft(editionId: string): void {
  const ls = safeLocalStorage();
  if (!ls || !editionId) return;
  try {
    ls.removeItem(key(editionId));
  } catch {
    /* ignore */
  }
}

/** Stable stringify of a payload for cheap equality (drift = unsaved changes). */
export function draftFingerprint(payload: EditionDraftPayload): string {
  try {
    return stableStringify(payload);
  } catch {
    return '';
  }
}

/**
 * JSON with object keys sorted, so the same content always gives the same
 * string. Postgres jsonb returns keys in its own order and the Puck canvas
 * re-emits them in another, so a plain JSON.stringify called an untouched
 * edition "changed": a false "unsaved changes" banner after a reload, and a
 * dirty flag after merely clicking a block.
 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}
