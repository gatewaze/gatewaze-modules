import { describe, it, expect } from 'vitest';
import { trimReplyBody, prepareReply, toBatches } from '../prepare.js';

describe('trimReplyBody', () => {
  it('keeps the reply and drops the Gmail quoted thread', () => {
    const raw = 'Loop engineering\r\n\r\nOn Wed, Jul 8, 2026 at 5:06 PM Demetrios wrote:\r\n> the whole newsletter...';
    expect(trimReplyBody(raw)).toBe('Loop engineering');
  });

  it('drops a French quoted thread', () => {
    const raw = 'Observability\n\nLe mer. 8 juil. 2026, 23:06, Demetrios a écrit :\n> ...';
    expect(trimReplyBody(raw)).toBe('Observability');
  });

  it('drops an Outlook signature/header block', () => {
    const raw = 'Harness\n\nFrom: Demetrios\nSent: Wednesday\nSubject: ...';
    expect(trimReplyBody(raw)).toBe('Harness');
  });

  it('caps very long bodies', () => {
    const raw = 'x'.repeat(5000);
    expect(trimReplyBody(raw, 600)).toHaveLength(600);
  });

  it('returns empty string for null/empty', () => {
    expect(trimReplyBody(null)).toBe('');
    expect(trimReplyBody('')).toBe('');
  });

  it('keeps a body with no quote markers intact', () => {
    expect(trimReplyBody('Agentic AI is everywhere')).toBe('Agentic AI is everywhere');
  });
});

describe('prepareReply', () => {
  it('coerces nulls and trims the body', () => {
    const p = prepareReply({
      id: 'r1',
      from_name: null,
      subject: null,
      body_text: 'MCP\n\nOn Mon someone wrote:\n> quoted',
      metadata: null,
    });
    expect(p).toEqual({ id: 'r1', from_name: '', subject: '', body_text: 'MCP' });
  });
});

describe('toBatches', () => {
  it('splits into fixed-size batches preserving order', () => {
    expect(toBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('returns one batch when size >= length', () => {
    expect(toBatches([1, 2], 12)).toEqual([[1, 2]]);
  });
  it('handles empty input', () => {
    expect(toBatches([], 12)).toEqual([]);
  });
});
