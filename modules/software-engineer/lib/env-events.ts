// @ts-nocheck — supabase client resolved at module-host install time.
/**
 * Ingests test-environment observability events from the staging box into the
 * module DB (migration 025). The host-side writers (staging-multienv.sh, the
 * pr-view tailer LaunchAgent) append one JSON object per line to
 * /staging-control/events.jsonl:
 *
 *   {"ts":"2026-08-23T12:00:00Z","kind":"ready","env":"lfx--newsletter-80",
 *    "detail":"…","meta":{…}}
 *
 * Ingestion is a side-effect of the admin polling GET /test-env/envs (~30-60s
 * while the Overview is open): read from a byte-offset cursor, parse the new
 * complete lines, insert sanitized rows, advance the cursor. Single-writer by
 * an in-process guard — the platform runs one api container, and a rare
 * concurrent poll simply skips (the next poll catches up).
 *
 * Hostile-input posture: the events file is written by trusted host agents,
 * but everything is still validated/capped here (kinds shape-checked, labels
 * grammar-shaped, strings length-capped, meta size-capped) so a corrupt or
 * malicious line can neither break ingestion nor smuggle oversized/unshaped
 * content into the DB and the admin UI.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';

const KIND_RE = /^[a-z][a-z0-9_]{0,31}$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,52}[a-z0-9])?$/;
const MAX_LINES_PER_INGEST = 500;
const MAX_LINE_BYTES = 8192;
const MAX_DETAIL = 2000;
const MAX_META_JSON = 2000;

/** Parse + sanitize one JSONL line → a row for se_env_events, or null. */
export function parseEventLine(line: string): Record<string, unknown> | null {
  if (!line.trim() || line.length > MAX_LINE_BYTES) return null;
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const ts = Date.parse(String(obj.ts ?? ''));
  if (Number.isNaN(ts)) return null;
  const kind = String(obj.kind ?? '');
  if (!KIND_RE.test(kind)) return null;
  const rawEnv = obj.env == null ? null : String(obj.env);
  const env_label = rawEnv && LABEL_RE.test(rawEnv) ? rawEnv : null;
  const detail = obj.detail == null ? null : String(obj.detail).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, MAX_DETAIL);
  let meta = null;
  if (typeof obj.meta === 'object' && obj.meta !== null && !Array.isArray(obj.meta)) {
    try {
      meta = JSON.stringify(obj.meta).length <= MAX_META_JSON ? obj.meta : { truncated: true };
    } catch { meta = null; }
  }
  return { ts: new Date(ts).toISOString(), kind, profile: 'lfx', env_label, detail, meta };
}

/**
 * Split the unread tail of the events file into rows + the number of bytes
 * actually consumed (up to and including the last complete newline — a
 * partially-written final line is left for the next poll). Exported for tests.
 */
export function sliceEvents(buf: Buffer, offset: number): { rows: Record<string, unknown>[]; consumed: number } {
  const tail = buf.subarray(offset);
  const lastNl = tail.lastIndexOf(0x0a);
  if (lastNl < 0) return { rows: [], consumed: 0 };
  const complete = tail.subarray(0, lastNl + 1);
  const rows = [];
  for (const line of complete.toString('utf8').split('\n')) {
    if (rows.length >= MAX_LINES_PER_INGEST) break;
    const row = parseEventLine(line);
    if (row) rows.push(row);
  }
  return { rows, consumed: complete.length };
}

/** Most bytes to pull off the file in a single poll. */
export const MAX_READ_BYTES = 1 << 20; // 1 MiB

/**
 * Read the unread tail from `offset`, bounded to MAX_READ_BYTES.
 *
 * The events file is append-only and nothing on the box rotates or prunes it,
 * so it only ever grows: slurping the whole thing on every poll (every 6-30s
 * while the Overview is open) would cost more and more memory for the same
 * handful of new lines. A positional read costs the same whether the file is
 * 8 KB or 800 MB. When more than MAX_READ_BYTES is outstanding the cursor just
 * advances a chunk at a time and the next poll continues — a backlog drains in
 * seconds at this cadence.
 */
export function readTail(path: string, offset: number): { size: number; chunk: Buffer } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (!Number.isFinite(size) || offset >= size) return { size, chunk: Buffer.alloc(0) };
    const len = Math.min(size - offset, MAX_READ_BYTES);
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    return { size, chunk: buf.subarray(0, read) };
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * Filesystem identity of the events file ("<dev>:<ino>"), or null when the
 * platform/stat does not expose it.
 *
 * The byte cursor is only meaningful for the file it was taken against. A
 * copy-truncate rotation is caught by the offset-vs-length check below (the
 * file shrinks), but a RENAME rotation — events.jsonl moved aside, a fresh one
 * created — is invisible to that check: if the replacement grows past the
 * stale offset before the next poll (polls are 6-30s apart), ingestion resumes
 * mid-file, silently skipping events and very likely landing mid-line. The
 * inode changes on a rename rotation, so comparing it is the cheap, correct
 * test. Stored in se_env_events_cursor.file_id (migration 026).
 */
export function fileIdentity(path: string): string | null {
  try {
    const st: { dev?: number | bigint; ino?: number | bigint } = statSync(path);
    if (st?.ino === undefined || st.ino === null) return null;
    return `${st.dev ?? 0}:${st.ino}`;
  } catch {
    return null;
  }
}

/** Default window of history the explorer keeps. Overridable per deployment. */
export const RETENTION_DAYS_DEFAULT = 14;
/** At most one prune per process per hour — it rides the poll, not a cron. */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export function retentionDays(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SE_ENV_EVENTS_RETENTION_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : RETENTION_DAYS_DEFAULT;
}

let lastPruneAt = 0;

/**
 * Retention: delete events older than the window. se_env_events is append-only
 * and the host tailers emit continuously (bucketed visits, login attempts,
 * error spans), so without this the table grows without bound and every
 * explorer query gets slower forever. Best-effort and rate-limited: a failed
 * or unsupported delete just means the next poll tries again.
 *
 * Exported (and time-injectable) for the unit test. Returns true when a prune
 * was actually attempted.
 */
export async function pruneEnvEvents(supabase, now: number = Date.now()): Promise<boolean> {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return false;
  lastPruneAt = now;
  const cutoff = new Date(now - retentionDays() * 86_400_000).toISOString();
  try {
    await supabase.from('se_env_events').delete().lt('ts', cutoff);
  } catch { /* best-effort */ }
  return true;
}

/** Test seam: forget the last-prune timestamp. */
export function _resetPruneClock(): void { lastPruneAt = 0; }

let ingestInFlight = false;

/**
 * Best-effort ingest — never throws (callers treat it as a poll side-effect).
 * Returns the number of rows inserted, or 0.
 */
export async function ingestEnvEvents(supabase, path = '/staging-control/events.jsonl'): Promise<number> {
  if (ingestInFlight) return 0;
  ingestInFlight = true;
  try {
    if (!existsSync(path)) return 0;
    const fileId = fileIdentity(path);
    // select('*'): the file_id column may not exist yet on a deployment where
    // migration 026 has not been applied. Naming it would 400 the whole read.
    const { data: cur } = await supabase.from('se_env_events_cursor').select('*').eq('id', 1).maybeSingle();
    const storedFileId = typeof cur?.file_id === 'string' && cur.file_id ? cur.file_id : null;
    const rotated = fileId !== null && storedFileId !== null && storedFileId !== fileId;
    let offset = rotated ? 0 : Number(cur?.byte_offset ?? 0);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    // One stat+read pair through the same fd: the size we compare against is
    // the size of the file we actually read, with no stat-then-read window.
    let tail = readTail(path, offset);
    if (tail === null) return 0;
    if (offset > tail.size) { // truncated in place → restart from the top
      offset = 0;
      tail = readTail(path, 0);
      if (tail === null) return 0;
    }
    if (tail.chunk.length === 0) {
      await pruneEnvEvents(supabase);
      return 0;
    }
    const { rows, consumed } = sliceEvents(tail.chunk, 0);
    if (consumed === 0) {
      // A full chunk with no newline in it can only be a line longer than the
      // read window — far past MAX_LINE_BYTES, so it would be discarded anyway.
      // Skip past it rather than re-reading the same bytes forever.
      if (tail.chunk.length >= MAX_READ_BYTES) {
        await supabase.from('se_env_events_cursor').upsert({
          id: 1, byte_offset: offset + tail.chunk.length, updated_at: new Date().toISOString(),
          ...(fileId ? { file_id: fileId } : {}),
        });
      }
      return 0;
    }
    if (rows.length > 0) {
      const { error } = await supabase.from('se_env_events').insert(rows);
      if (error) return 0; // cursor NOT advanced — retried next poll
    }
    const next = { id: 1, byte_offset: offset + consumed, updated_at: new Date().toISOString() };
    if (fileId) {
      // Same pre-026 tolerance as the read: fall back to the 025 shape if the
      // column is missing, so ingestion never wedges on migration ordering.
      const { error } = await supabase.from('se_env_events_cursor').upsert({ ...next, file_id: fileId });
      if (error) await supabase.from('se_env_events_cursor').upsert(next);
    } else {
      await supabase.from('se_env_events_cursor').upsert(next);
    }
    await pruneEnvEvents(supabase);
    return rows.length;
  } catch {
    return 0;
  } finally {
    ingestInFlight = false;
  }
}
