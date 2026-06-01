import { describe, it, expect } from 'vitest';
import {
  rowsToTranscript,
  copilotStatusLabel,
  statusBaseLabel,
  type AiMessageRow,
} from '../lib/transcript.js';

describe('statusBaseLabel', () => {
  it('maps every mode to its base label', () => {
    expect(statusBaseLabel('replace')).toBe('Replaced page');
    expect(statusBaseLabel('append')).toBe('Appended blocks');
    expect(statusBaseLabel('insert-after')).toBe('Inserted blocks');
    expect(statusBaseLabel('edit')).toBe('Edited page');
    expect(statusBaseLabel('edit-block')).toBe('Updated block');
  });
});

describe('copilotStatusLabel', () => {
  it('adds a pluralised block count for the sequence-producing modes', () => {
    expect(copilotStatusLabel('replace', 3)).toBe('Replaced page (3 blocks)');
    expect(copilotStatusLabel('append', 1)).toBe('Appended blocks (1 block)');
    expect(copilotStatusLabel('insert-after', 2)).toBe('Inserted blocks (2 blocks)');
  });
  it('omits the count for edit and edit-block', () => {
    expect(copilotStatusLabel('edit', 5)).toBe('Edited page');
    expect(copilotStatusLabel('edit-block', 1)).toBe('Updated block');
  });
});

describe('rowsToTranscript', () => {
  it('maps a user row to a single user bubble', () => {
    const rows: AiMessageRow[] = [{ id: 'm1', role: 'user', status: 'complete', content: 'make it punchier' }];
    expect(rowsToTranscript(rows)).toEqual([{ id: 'm1-u', kind: 'user', text: 'make it punchier' }]);
  });

  it('expands a successful assistant row into status + meta (no empty assistant line)', () => {
    const rows: AiMessageRow[] = [
      {
        id: 'a1',
        role: 'assistant',
        status: 'complete',
        content: '',
        structured: {
          copilot: { status_label: 'Replaced page (3 blocks)', status_state: 'success' },
          usage: { tokens: 1200, cost_approx: 0.0042, duration_ms: 5300 },
        },
      },
    ];
    expect(rowsToTranscript(rows)).toEqual([
      { id: 'a1-s', kind: 'status', label: 'Replaced page (3 blocks)', state: 'success' },
      { id: 'a1-m', kind: 'meta', tokens: 1200, cost_approx: 0.0042, duration_ms: 5300 },
    ]);
  });

  it('expands a failed assistant row into an error status + the error text', () => {
    const rows: AiMessageRow[] = [
      {
        id: 'a2',
        role: 'assistant',
        status: 'failed',
        content: 'provider exceeded wall-clock',
        structured: { copilot: { status_label: 'Error: ai_timeout', status_state: 'error' } },
      },
    ];
    expect(rowsToTranscript(rows)).toEqual([
      { id: 'a2-s', kind: 'status', label: 'Error: ai_timeout', state: 'error' },
      { id: 'a2-a', kind: 'assistant', text: 'provider exceeded wall-clock' },
    ]);
  });

  it('falls back to a generic error status for a failed row with no structured payload', () => {
    const rows: AiMessageRow[] = [{ id: 'a3', role: 'assistant', status: 'failed', content: 'boom' }];
    expect(rowsToTranscript(rows)).toEqual([
      { id: 'a3-s', kind: 'status', label: 'Error', state: 'error' },
      { id: 'a3-a', kind: 'assistant', text: 'boom' },
    ]);
  });

  it('round-trips a full two-turn conversation in order', () => {
    const rows: AiMessageRow[] = [
      { id: 'u1', role: 'user', content: 'write an intro' },
      {
        id: 'r1',
        role: 'assistant',
        status: 'complete',
        content: '',
        structured: {
          copilot: { status_label: 'Replaced page (2 blocks)', status_state: 'success' },
          usage: { tokens: 800, cost_approx: 0.003, duration_ms: 4100 },
        },
      },
      { id: 'u2', role: 'user', content: 'now shorten it' },
      {
        id: 'r2',
        role: 'assistant',
        status: 'complete',
        content: '',
        structured: {
          copilot: { status_label: 'Edited page', status_state: 'success' },
          usage: { tokens: 500, cost_approx: 0.002, duration_ms: 3000 },
        },
      },
    ];
    const out = rowsToTranscript(rows);
    expect(out.map((m) => m.kind)).toEqual(['user', 'status', 'meta', 'user', 'status', 'meta']);
    expect(out[1]).toMatchObject({ kind: 'status', label: 'Replaced page (2 blocks)' });
    expect(out[4]).toMatchObject({ kind: 'status', label: 'Edited page' });
  });

  it('skips system / tool_summary rows', () => {
    const rows: AiMessageRow[] = [
      { id: 's1', role: 'system', content: 'you are a copilot' },
      { id: 't1', role: 'tool_summary', content: 'searched the web' },
      { id: 'u1', role: 'user', content: 'hi' },
    ];
    expect(rowsToTranscript(rows)).toEqual([{ id: 'u1-u', kind: 'user', text: 'hi' }]);
  });
});
