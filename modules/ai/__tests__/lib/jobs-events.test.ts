/**
 * Tests for lib/jobs/events.ts — redaction + hash<->event round trips.
 */

import { describe, expect, it } from 'vitest';
import {
  eventToHashFields,
  hashFieldsToEvent,
  redactSensitive,
  type StreamEvent,
} from '../../lib/jobs/events.js';

describe('redactSensitive', () => {
  it('replaces values under sensitive top-level keys', () => {
    expect(redactSensitive({ api_key: 'sk-123', name: 'alice' })).toEqual({
      api_key: '<redacted>',
      name: 'alice',
    });
  });

  it('matches by case-insensitive substring (key|secret|token|password|authorization)', () => {
    const out = redactSensitive({
      SECRET_TOKEN: 'a',
      Authorization: 'Bearer x',
      passwordHash: 'b',
      keyMaterial: 'c',
      benign: 'd',
    });
    expect(out).toEqual({
      SECRET_TOKEN: '<redacted>',
      Authorization: '<redacted>',
      passwordHash: '<redacted>',
      keyMaterial: '<redacted>',
      benign: 'd',
    });
  });

  it('walks nested objects', () => {
    const out = redactSensitive({
      level1: {
        level2: { api_key: 'sk-456', safe: 'ok' },
      },
    });
    expect(out).toEqual({
      level1: { level2: { api_key: '<redacted>', safe: 'ok' } },
    });
  });

  it('walks arrays', () => {
    const out = redactSensitive([{ api_key: 'a' }, { name: 'bob' }]);
    expect(out).toEqual([{ api_key: '<redacted>' }, { name: 'bob' }]);
  });

  it('leaves Date objects untouched', () => {
    const d = new Date('2026-05-19T00:00:00Z');
    expect(redactSensitive({ when: d })).toEqual({ when: d });
  });

  it('returns scalars unchanged', () => {
    expect(redactSensitive('hello')).toBe('hello');
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBe(null);
  });
});

describe('eventToHashFields / hashFieldsToEvent', () => {
  it('round-trips a simple event', () => {
    const e: StreamEvent = { type: 'token', ts: 1000, delta: 'hello' };
    const h = eventToHashFields(e);
    expect(h.type).toBe('token');
    const parsed = JSON.parse(h.payload);
    expect(parsed.delta).toBe('hello');
    const back = hashFieldsToEvent(1000, ['type', h.type, 'payload', h.payload]);
    expect(back).toEqual(e);
  });

  it('redacts sensitive args on tool_call', () => {
    const e: StreamEvent = {
      type: 'tool_call',
      ts: 1000,
      step_index: 0,
      tool_name: 'fetch_url',
      args: { url: 'https://x', api_key: 'sk-secret' },
    };
    const h = eventToHashFields(e);
    const parsed = JSON.parse(h.payload);
    expect(parsed.args.api_key).toBe('<redacted>');
    expect(parsed.args.url).toBe('https://x');
  });

  it('handles unparseable payload gracefully', () => {
    const back = hashFieldsToEvent(1000, ['type', 'token', 'payload', '{not json']);
    expect(back).toEqual({ type: 'token', ts: 1000 });
  });

  it('returns null when type field absent', () => {
    expect(hashFieldsToEvent(1000, ['payload', '{}'])).toBeNull();
  });

  it('accepts object kv map (not just flat array)', () => {
    const back = hashFieldsToEvent(1234, {
      type: 'step.start',
      payload: JSON.stringify({ step_index: 2, step_id: 'research' }),
    });
    expect(back).toEqual({ type: 'step.start', ts: 1234, step_index: 2, step_id: 'research' });
  });
});
