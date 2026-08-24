/**
 * Ingestion of /staging-control/events.jsonl (lib/env-events.ts): line
 * parsing/sanitization and the byte-cursor slice semantics. The fs-touching
 * ingestEnvEvents wrapper is exercised through the route test
 * (admin/__tests__/test-env-envs-route.test.ts); these tests pin the pure
 * parts, which is where the hostile-input handling lives.
 */
import { describe, it, expect } from 'vitest';
import { parseEventLine, sliceEvents } from '../env-events.js';

const line = (o: unknown) => JSON.stringify(o);

describe('parseEventLine', () => {
  it('parses a well-formed lifecycle event', () => {
    expect(parseEventLine(line({ ts: '2026-08-23T10:00:00Z', kind: 'ready', env: 'lfx--newsletter-80', detail: 'deployed', meta: { port: 4201 } })))
      .toEqual({
        ts: '2026-08-23T10:00:00.000Z', kind: 'ready', profile: 'lfx',
        env_label: 'lfx--newsletter-80', detail: 'deployed', meta: { port: 4201 },
      });
  });
  it('accepts env-less events (shared-Authelia logins)', () => {
    const row = parseEventLine(line({ ts: '2026-08-23T10:00:00Z', kind: 'login_failure', meta: { username: 'x' } }));
    expect(row).toMatchObject({ kind: 'login_failure', env_label: null });
  });
  it('nulls an env that fails the label shape instead of storing it', () => {
    const row = parseEventLine(line({ ts: '2026-08-23T10:00:00Z', kind: 'visit', env: '../etc/passwd' }));
    expect(row).toMatchObject({ kind: 'visit', env_label: null });
  });
  it('rejects malformed JSON, bad timestamps, and unshaped kinds', () => {
    expect(parseEventLine('not json')).toBeNull();
    expect(parseEventLine(line({ ts: 'yesterday', kind: 'ready' }))).toBeNull();
    expect(parseEventLine(line({ ts: '2026-08-23T10:00:00Z', kind: 'DROP TABLE' }))).toBeNull();
    expect(parseEventLine(line({ ts: '2026-08-23T10:00:00Z' }))).toBeNull();
    expect(parseEventLine(line(['ts', 'kind'])))
      .toBeNull();
    expect(parseEventLine('')).toBeNull();
  });
  it('caps detail length and strips control characters', () => {
    const row = parseEventLine(line({ ts: '2026-08-23T10:00:00Z', kind: 'fail', detail: `a\x00b\x1bc${'x'.repeat(5000)}` }));
    expect(row?.detail).toMatch(/^abc/);
    expect((row?.detail as string).length).toBeLessThanOrEqual(2000);
  });
  it('replaces oversized meta with {truncated: true} and drops non-object meta', () => {
    const big = parseEventLine(line({ ts: '2026-08-23T10:00:00Z', kind: 'visit', meta: { blob: 'y'.repeat(5000) } }));
    expect(big?.meta).toEqual({ truncated: true });
    const arr = parseEventLine(line({ ts: '2026-08-23T10:00:00Z', kind: 'visit', meta: [1, 2] }));
    expect(arr?.meta).toBeNull();
  });
  it('rejects a line over the byte cap outright', () => {
    expect(parseEventLine(line({ ts: '2026-08-23T10:00:00Z', kind: 'visit', detail: 'z'.repeat(10000) }))).toBeNull();
  });
});

describe('sliceEvents', () => {
  const l1 = line({ ts: '2026-08-23T10:00:00Z', kind: 'create', env: 'lfx--newsletter-80' });
  const l2 = line({ ts: '2026-08-23T10:01:00Z', kind: 'ready', env: 'lfx--newsletter-80' });

  it('consumes complete lines from the offset and reports the exact byte count', () => {
    const buf = Buffer.from(`${l1}\n${l2}\n`);
    const { rows, consumed } = sliceEvents(buf, 0);
    expect(rows.map((r) => r.kind)).toEqual(['create', 'ready']);
    expect(consumed).toBe(buf.length);
  });
  it('starts at the given offset (already-ingested lines are not re-read)', () => {
    const buf = Buffer.from(`${l1}\n${l2}\n`);
    const offset = Buffer.byteLength(`${l1}\n`);
    const { rows, consumed } = sliceEvents(buf, offset);
    expect(rows.map((r) => r.kind)).toEqual(['ready']);
    expect(offset + consumed).toBe(buf.length);
  });
  it('leaves a partially-written final line for the next poll', () => {
    const partial = l2.slice(0, 10);
    const buf = Buffer.from(`${l1}\n${partial}`);
    const { rows, consumed } = sliceEvents(buf, 0);
    expect(rows).toHaveLength(1);
    expect(consumed).toBe(Buffer.byteLength(`${l1}\n`));
  });
  it('returns nothing when no complete line exists past the offset', () => {
    const { rows, consumed } = sliceEvents(Buffer.from('{"half'), 0);
    expect(rows).toEqual([]);
    expect(consumed).toBe(0);
  });
  it('skips unparseable lines while still consuming their bytes (no poison-pill stall)', () => {
    const buf = Buffer.from(`garbage\n${l2}\n`);
    const { rows, consumed } = sliceEvents(buf, 0);
    expect(rows.map((r) => r.kind)).toEqual(['ready']);
    expect(consumed).toBe(buf.length);
  });
});
