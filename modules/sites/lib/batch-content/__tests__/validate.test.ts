import { describe, expect, it } from 'vitest';
import {
  validateBatchShape,
  MAX_BATCH_SIZE,
  MAX_CONTENT_BYTES_PER_DRAFT,
} from '../validate.js';

const validDraft = (route: string, content: Record<string, unknown> = { title: 'X' }) => ({
  route,
  content,
  schemaVersion: 1,
});

describe('validateBatchShape()', () => {
  it('accepts a single valid draft', () => {
    const r = validateBatchShape({ drafts: [validDraft('/about')] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]?.route).toBe('/about');
    expect(r.drafts[0]?.baseCommitSha).toBe(null);
  });

  it('normalizes routes', () => {
    const r = validateBatchShape({ drafts: [validDraft('//about//')] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drafts[0]?.route).toBe('/about');
  });

  it('accepts a batch with multiple distinct routes', () => {
    const r = validateBatchShape({
      drafts: [validDraft('/'), validDraft('/about'), validDraft('/contact')],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drafts.map((d) => d.route)).toEqual(['/', '/about', '/contact']);
  });

  it('rejects body that is not an object', () => {
    expect(validateBatchShape(null).ok).toBe(false);
    expect(validateBatchShape('string').ok).toBe(false);
  });

  it('rejects when drafts is missing or empty', () => {
    const r1 = validateBatchShape({});
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.reason).toBe('must_be_array');

    const r2 = validateBatchShape({ drafts: [] });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe('empty');
  });

  it('rejects batches that exceed the cap', () => {
    const drafts = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => validDraft(`/p${i}`));
    const r = validateBatchShape({ drafts });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('too_many');
  });

  it('rejects duplicate routes within a batch', () => {
    const r = validateBatchShape({
      drafts: [validDraft('/about'), validDraft('//about/')], // both normalize to /about
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('duplicate');
    expect(r.index).toBe(1);
  });

  it('rejects content that exceeds the per-draft byte cap', () => {
    const big = { hero: 'x'.repeat(MAX_CONTENT_BYTES_PER_DRAFT) };
    const r = validateBatchShape({ drafts: [{ ...validDraft('/big'), content: big }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('too_large');
  });

  it('rejects non-positive schemaVersion', () => {
    const r = validateBatchShape({
      drafts: [{ route: '/x', content: {}, schemaVersion: 0 }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.field).toBe('schemaVersion');
  });

  it('rejects malformed baseCommitSha', () => {
    const r = validateBatchShape({
      drafts: [{ route: '/x', content: {}, schemaVersion: 1, baseCommitSha: 'short' }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.field).toBe('baseCommitSha');
  });

  it('accepts valid 40-char hex baseCommitSha', () => {
    const r = validateBatchShape({
      drafts: [{
        route: '/x', content: {}, schemaVersion: 1,
        baseCommitSha: 'a'.repeat(40),
      }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drafts[0]?.baseCommitSha).toBe('a'.repeat(40));
  });

  it('reports the offending draft index for multi-draft failures', () => {
    const r = validateBatchShape({
      drafts: [
        validDraft('/ok'),
        validDraft('/also-ok'),
        { route: 'no-leading-slash', content: {}, schemaVersion: 1 },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.index).toBe(2);
    expect(r.field).toBe('route');
  });
});
