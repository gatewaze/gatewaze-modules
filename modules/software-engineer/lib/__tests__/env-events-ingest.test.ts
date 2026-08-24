/**
 * The fs-touching half of the events ingester (lib/env-events.ts): the byte
 * cursor's behaviour across the two ways /staging-control/events.jsonl can be
 * rotated by the host tailer, and the retention prune that keeps se_env_events
 * from growing without bound.
 *
 * The rotation cases are the reason this file exists. The cursor is a byte
 * offset, which is only meaningful for ONE file:
 *   · copy-truncate — same inode, length drops → the offset-vs-length check
 *     catches it (this was already handled in #213);
 *   · rename — new inode, length starts at 0 but can pass the stale offset
 *     before the next poll → only the inode comparison catches it, and without
 *     it ingestion resumes mid-line and silently loses events.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fs = vi.hoisted(() => ({
  content: '',
  ino: 1,
  missing: false,
  statThrows: false,
}));

// Positional-read fs double: ingestEnvEvents pulls a bounded chunk from the
// byte offset through one fd, so the mock has to model open/fstat/read/close
// rather than a whole-file slurp.
vi.mock('node:fs', () => ({
  existsSync: () => !fs.missing,
  openSync: () => { if (fs.missing) throw new Error('ENOENT'); return 7; },
  closeSync: () => {},
  fstatSync: () => ({ size: Buffer.byteLength(fs.content) }),
  readSync: (_fd: number, buf: Buffer, off: number, len: number, pos: number) =>
    Buffer.from(fs.content).copy(buf, off, pos, pos + len),
  statSync: () => {
    if (fs.statThrows) throw new Error('ENOENT');
    return { dev: 42, ino: fs.ino, size: Buffer.byteLength(fs.content) };
  },
}));

import {
  ingestEnvEvents, pruneEnvEvents, retentionDays, fileIdentity, _resetPruneClock,
  RETENTION_DAYS_DEFAULT, MAX_READ_BYTES,
} from '../env-events.js';

/** Supabase double holding a single cursor row and recording writes. */
function mockSupabase({ cursor = null, cursorUpsertFails = false, hasDelete = true } = {}) {
  const state = { cursor, inserted: [], upserted: [], deletedBefore: [] };
  const from = (table) => {
    const b = {
      select() { return b; },
      eq() { return b; },
      maybeSingle() { return Promise.resolve({ data: table === 'se_env_events_cursor' ? state.cursor : null, error: null }); },
      insert(rows) { state.inserted.push(...rows); return Promise.resolve({ data: null, error: null }); },
      upsert(rowIn) {
        // Emulate PostgREST 400ing on an unknown column (migration 026 unapplied).
        if (cursorUpsertFails && 'file_id' in rowIn) return Promise.resolve({ data: null, error: { message: 'no file_id column' } });
        state.upserted.push(rowIn);
        state.cursor = { ...(state.cursor ?? {}), ...rowIn };
        return Promise.resolve({ data: null, error: null });
      },
      lt(_col, v) { state.deletedBefore.push(v); return Promise.resolve({ data: null, error: null }); },
    };
    if (hasDelete) b.delete = () => b;
    return b;
  };
  return { from, _state: state };
}

const line = (o) => `${JSON.stringify(o)}\n`;
const ev = (kind, env = 'lfx--a1') => ({ ts: '2026-08-23T10:00:00Z', kind, env, detail: 'd' });

beforeEach(() => {
  fs.content = '';
  fs.ino = 1;
  fs.missing = false;
  fs.statThrows = false;
  _resetPruneClock();
});

describe('cursor advance', () => {
  it('ingests the whole file from a cold cursor and records the file identity', async () => {
    fs.content = line(ev('create')) + line(ev('ready'));
    const sb = mockSupabase();
    expect(await ingestEnvEvents(sb, '/events.jsonl')).toBe(2);
    expect(sb._state.upserted[0]).toMatchObject({ id: 1, byte_offset: fs.content.length, file_id: '42:1' });
  });

  it('ingests only the appended tail on the next poll', async () => {
    fs.content = line(ev('create'));
    const sb = mockSupabase();
    await ingestEnvEvents(sb, '/events.jsonl');
    fs.content += line(ev('ready'));
    _resetPruneClock();
    expect(await ingestEnvEvents(sb, '/events.jsonl')).toBe(1);
    expect(sb._state.inserted.map((r) => r.kind)).toEqual(['create', 'ready']);
  });

  it('does nothing when there is no new complete line', async () => {
    fs.content = line(ev('create'));
    const sb = mockSupabase();
    await ingestEnvEvents(sb, '/events.jsonl');
    expect(await ingestEnvEvents(sb, '/events.jsonl')).toBe(0);
    expect(sb._state.inserted).toHaveLength(1);
  });
});

describe('bounded read', () => {
  it('never pulls more than one chunk per poll, and drains the backlog across polls', async () => {
    // The events file is append-only and nothing rotates it, so it can be very
    // large; a poll must cost a chunk, not the whole file.
    const one = line(ev('visit'));
    const per = one.length;
    const count = Math.ceil((MAX_READ_BYTES * 1.5) / per);
    fs.content = one.repeat(count);
    const sb = mockSupabase();

    await ingestEnvEvents(sb, '/events.jsonl');
    const first = sb._state.upserted[0].byte_offset;
    expect(first).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(first).toBeGreaterThan(MAX_READ_BYTES - per);

    _resetPruneClock();
    await ingestEnvEvents(sb, '/events.jsonl');
    expect(sb._state.upserted.at(-1).byte_offset).toBeGreaterThan(first);
  });

  it('skips past a single line longer than the read window instead of wedging', async () => {
    fs.content = `${'x'.repeat(MAX_READ_BYTES + 10)}\n${line(ev('ready'))}`;
    const sb = mockSupabase();
    expect(await ingestEnvEvents(sb, '/events.jsonl')).toBe(0);
    expect(sb._state.upserted[0].byte_offset).toBe(MAX_READ_BYTES);
    _resetPruneClock();
    // The next polls walk past the junk and reach the real line behind it.
    for (let i = 0; i < 3; i += 1) { await ingestEnvEvents(sb, '/events.jsonl'); _resetPruneClock(); }
    expect(sb._state.inserted.map((r) => r.kind)).toEqual(['ready']);
  });
});

describe('rotation', () => {
  it('restarts at 0 when the file is truncated in place (same inode, shorter)', async () => {
    fs.content = line(ev('create')) + line(ev('ready'));
    const sb = mockSupabase();
    await ingestEnvEvents(sb, '/events.jsonl');
    fs.content = line(ev('teardown'));   // copy-truncate: same inode, now shorter
    _resetPruneClock();
    expect(await ingestEnvEvents(sb, '/events.jsonl')).toBe(1);
    expect(sb._state.inserted.map((r) => r.kind)).toEqual(['create', 'ready', 'teardown']);
  });

  it('restarts at 0 when the file is REPLACED and has already grown past the stale offset', async () => {
    // The case a length check alone cannot see: two events ingested, the file
    // is renamed away, and the replacement is longer than the old one by the
    // time the next poll lands.
    fs.content = line(ev('create')) + line(ev('ready'));
    const sb = mockSupabase();
    await ingestEnvEvents(sb, '/events.jsonl');
    const staleOffset = sb._state.upserted[0].byte_offset;

    fs.ino = 2;
    fs.content = line(ev('visit')) + line(ev('visit')) + line(ev('visit')) + line(ev('service_error'));
    expect(fs.content.length).toBeGreaterThan(staleOffset);   // the trap
    _resetPruneClock();

    expect(await ingestEnvEvents(sb, '/events.jsonl')).toBe(4);
    expect(sb._state.inserted.slice(2).map((r) => r.kind)).toEqual(['visit', 'visit', 'visit', 'service_error']);
    expect(sb._state.upserted.at(-1)).toMatchObject({ file_id: '42:2' });
  });

  it('keeps working when the platform gives no inode (falls back to the length check)', async () => {
    fs.statThrows = true;
    expect(fileIdentity('/events.jsonl')).toBeNull();
    fs.content = line(ev('create'));
    const sb = mockSupabase();
    expect(await ingestEnvEvents(sb, '/events.jsonl')).toBe(1);
    expect(sb._state.upserted[0]).not.toHaveProperty('file_id');
  });

  it('falls back to the pre-026 cursor shape when the file_id column is missing', async () => {
    fs.content = line(ev('create'));
    const sb = mockSupabase({ cursorUpsertFails: true });
    expect(await ingestEnvEvents(sb, '/events.jsonl')).toBe(1);
    expect(sb._state.upserted).toHaveLength(1);
    expect(sb._state.upserted[0]).toEqual({ id: 1, byte_offset: fs.content.length, updated_at: expect.any(String) });
  });

  it('ignores a corrupt cursor offset past the end of the file', async () => {
    fs.content = line(ev('create'));
    const sb = mockSupabase({ cursor: { byte_offset: 999_999, file_id: '42:1' } });
    expect(await ingestEnvEvents(sb, '/events.jsonl')).toBe(1);
  });
});

describe('retention', () => {
  it('deletes events older than the window, once per hour', async () => {
    const sb = mockSupabase();
    const now = Date.parse('2026-08-23T12:00:00.000Z');
    expect(await pruneEnvEvents(sb, now)).toBe(true);
    expect(sb._state.deletedBefore).toEqual([
      new Date(now - RETENTION_DAYS_DEFAULT * 86_400_000).toISOString(),
    ]);
    // A second call inside the hour is a no-op, so a busy poll loop does not
    // fire a delete every few seconds.
    expect(await pruneEnvEvents(sb, now + 60_000)).toBe(false);
    expect(await pruneEnvEvents(sb, now + 3_600_001)).toBe(true);
    expect(sb._state.deletedBefore).toHaveLength(2);
  });

  it('rides the ingest poll', async () => {
    fs.content = line(ev('create'));
    const sb = mockSupabase();
    await ingestEnvEvents(sb, '/events.jsonl');
    expect(sb._state.deletedBefore).toHaveLength(1);
  });

  it('never breaks ingestion when the delete is unavailable', async () => {
    fs.content = line(ev('create'));
    const sb = mockSupabase({ hasDelete: false });
    expect(await ingestEnvEvents(sb, '/events.jsonl')).toBe(1);
  });

  it('honours a per-deployment override and refuses a nonsense one', () => {
    expect(retentionDays({})).toBe(RETENTION_DAYS_DEFAULT);
    expect(retentionDays({ SE_ENV_EVENTS_RETENTION_DAYS: '30' })).toBe(30);
    for (const v of ['0', '400', 'forever', '1.5', '']) {
      expect(retentionDays({ SE_ENV_EVENTS_RETENTION_DAYS: v }), v).toBe(RETENTION_DAYS_DEFAULT);
    }
  });
});

describe('missing file', () => {
  it('is a silent no-op on a deployment with no staging channel', async () => {
    fs.missing = true;
    const sb = mockSupabase();
    expect(await ingestEnvEvents(sb, '/events.jsonl')).toBe(0);
    expect(sb._state.inserted).toHaveLength(0);
  });
});
