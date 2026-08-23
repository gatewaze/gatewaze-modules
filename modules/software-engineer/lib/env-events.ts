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
import { existsSync, readFileSync } from 'node:fs';

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
    // Single read; the size check runs against the bytes actually read (no
    // stat-then-read window — the file is append-only between rotations).
    const buf = readFileSync(path);
    const { data: cur } = await supabase.from('se_env_events_cursor').select('byte_offset').eq('id', 1).maybeSingle();
    let offset = Number(cur?.byte_offset ?? 0);
    if (!Number.isFinite(offset) || offset < 0 || offset > buf.length) offset = 0; // rotated/truncated → restart
    if (offset === buf.length) return 0;
    const { rows, consumed } = sliceEvents(buf, offset);
    if (consumed === 0) return 0;
    if (rows.length > 0) {
      const { error } = await supabase.from('se_env_events').insert(rows);
      if (error) return 0; // cursor NOT advanced — retried next poll
    }
    await supabase.from('se_env_events_cursor').upsert({ id: 1, byte_offset: offset + consumed, updated_at: new Date().toISOString() });
    return rows.length;
  } catch {
    return 0;
  } finally {
    ingestInFlight = false;
  }
}
