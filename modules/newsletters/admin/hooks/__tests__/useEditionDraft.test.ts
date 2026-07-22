import { describe, it, expect, beforeEach } from 'vitest';
import { readDraft, writeDraft, clearDraft, draftFingerprint } from '../useEditionDraft.js';

// Minimal localStorage for the node test env.
class MemStore {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key() { return null; }
  get length() { return this.m.size; }
}
beforeEach(() => { (globalThis as unknown as { localStorage: unknown }).localStorage = new MemStore(); });

const payload = { subject: 'S', preheader: 'P', edition_date: '2026-07-23', blocks: [{ id: 'a', x: 1 }] };

describe('useEditionDraft', () => {
  it('round-trips write → read', () => {
    writeDraft('ed1', payload, 123);
    const d = readDraft('ed1');
    expect(d?.savedAt).toBe(123);
    expect(d?.payload).toEqual(payload);
  });

  it('clearDraft removes it', () => {
    writeDraft('ed1', payload, 1);
    clearDraft('ed1');
    expect(readDraft('ed1')).toBeNull();
  });

  it('never persists a draft for a new / empty edition id', () => {
    writeDraft('new', payload, 1);
    writeDraft('', payload, 1);
    expect(readDraft('new')).toBeNull();
    expect(readDraft('')).toBeNull();
  });

  it('readDraft returns null for absent or malformed data', () => {
    expect(readDraft('missing')).toBeNull();
    (globalThis as unknown as { localStorage: Storage }).localStorage.setItem('nl-edition-draft:v1:bad', '{not json');
    expect(readDraft('bad')).toBeNull();
  });

  it('draftFingerprint is stable + content-sensitive', () => {
    expect(draftFingerprint(payload)).toBe(draftFingerprint({ ...payload }));
    expect(draftFingerprint(payload)).not.toBe(draftFingerprint({ ...payload, subject: 'X' }));
  });

  it('does not throw when localStorage is unavailable', () => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
    expect(() => writeDraft('ed1', payload, 1)).not.toThrow();
    expect(readDraft('ed1')).toBeNull();
    expect(() => clearDraft('ed1')).not.toThrow();
  });
});
