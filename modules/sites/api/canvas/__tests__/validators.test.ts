// @ts-nocheck — vitest types resolved at workspace install time
import { describe, expect, it } from 'vitest';
import { validateEnvelope, validateOp } from '../validators.js';

const UUID = '11111111-2222-3333-4444-555555555555';
const TOKEN16 = '0123456789abcdef';

describe('validateEnvelope — top-level', () => {
  it('rejects non-object body', () => {
    expect(validateEnvelope(null).ok).toBe(false);
    expect(validateEnvelope('hi').ok).toBe(false);
    expect(validateEnvelope(42).ok).toBe(false);
  });

  it('requires non-empty ops', () => {
    expect(validateEnvelope({ ops: [], baseVersion: 0, clientToken: TOKEN16, idempotencyKey: UUID }).ok).toBe(false);
    expect(validateEnvelope({ baseVersion: 0, clientToken: TOKEN16, idempotencyKey: UUID }).ok).toBe(false);
  });

  it('caps ops length at 100', () => {
    const ops = Array.from({ length: 101 }, () => ({ kind: 'block.delete', blockId: UUID }));
    expect(validateEnvelope({ ops, baseVersion: 0, clientToken: TOKEN16, idempotencyKey: UUID }).ok).toBe(false);
  });

  it('requires non-negative integer baseVersion', () => {
    const env = { ops: [{ kind: 'block.delete', blockId: UUID }], clientToken: TOKEN16, idempotencyKey: UUID };
    expect(validateEnvelope({ ...env, baseVersion: -1 }).ok).toBe(false);
    expect(validateEnvelope({ ...env, baseVersion: 1.5 }).ok).toBe(false);
    expect(validateEnvelope({ ...env, baseVersion: 'x' }).ok).toBe(false);
    expect(validateEnvelope({ ...env, baseVersion: 0 }).ok).toBe(true);
    expect(validateEnvelope({ ...env, baseVersion: 7 }).ok).toBe(true);
  });

  it('requires clientToken in length 16..64', () => {
    const env = { ops: [{ kind: 'block.delete', blockId: UUID }], baseVersion: 0, idempotencyKey: UUID };
    expect(validateEnvelope({ ...env, clientToken: 'short' }).ok).toBe(false);
    expect(validateEnvelope({ ...env, clientToken: 'x'.repeat(65) }).ok).toBe(false);
    expect(validateEnvelope({ ...env, clientToken: 'x'.repeat(16) }).ok).toBe(true);
  });

  it('requires uuid-shape idempotencyKey', () => {
    const env = { ops: [{ kind: 'block.delete', blockId: UUID }], baseVersion: 0, clientToken: TOKEN16 };
    expect(validateEnvelope({ ...env, idempotencyKey: 'not-uuid' }).ok).toBe(false);
    expect(validateEnvelope({ ...env, idempotencyKey: UUID }).ok).toBe(true);
  });
});

describe('validateOp — kind dispatch', () => {
  it('rejects unknown kinds', () => {
    expect(validateOp({ kind: 'block.unknown' }).ok).toBe(false);
    expect(validateOp({ kind: '' }).ok).toBe(false);
    expect(validateOp({}).ok).toBe(false);
  });
});

describe('validateOp — block.insert', () => {
  it('accepts valid insert at top-level', () => {
    const r = validateOp({
      kind: 'block.insert',
      afterBlockId: null,
      parentBrickId: null,
      blockDefKey: 'hero',
      content: { title: 'X' },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects missing blockDefKey', () => {
    const r = validateOp({ kind: 'block.insert', afterBlockId: null, parentBrickId: null, content: {} });
    expect(r.ok).toBe(false);
  });

  it('rejects non-object content', () => {
    const r = validateOp({ kind: 'block.insert', afterBlockId: null, parentBrickId: null, blockDefKey: 'x', content: 'oops' });
    expect(r.ok).toBe(false);
  });

  it('rejects malformed afterBlockId', () => {
    const r = validateOp({ kind: 'block.insert', afterBlockId: 'not-uuid', parentBrickId: null, blockDefKey: 'x', content: {} });
    expect(r.ok).toBe(false);
  });
});

describe('validateOp — block.update_field', () => {
  it('accepts valid update', () => {
    const r = validateOp({ kind: 'block.update_field', blockId: UUID, fieldPath: 'title', newValue: 'X' });
    expect(r.ok).toBe(true);
  });

  it('rejects empty fieldPath', () => {
    const r = validateOp({ kind: 'block.update_field', blockId: UUID, fieldPath: '', newValue: '' });
    expect(r.ok).toBe(false);
  });

  it('rejects bad blockId', () => {
    const r = validateOp({ kind: 'block.update_field', blockId: 'x', fieldPath: 'title', newValue: '' });
    expect(r.ok).toBe(false);
  });

  it('accepts unknown newValue type — schema validation is downstream', () => {
    const r = validateOp({ kind: 'block.update_field', blockId: UUID, fieldPath: 'count', newValue: 42 });
    expect(r.ok).toBe(true);
    const r2 = validateOp({ kind: 'block.update_field', blockId: UUID, fieldPath: 'list', newValue: [1, 2] });
    expect(r2.ok).toBe(true);
  });
});

describe('validateOp — preset.apply', () => {
  it('accepts valid preset apply', () => {
    const r = validateOp({
      kind: 'preset.apply',
      afterBlockId: null,
      parentBrickId: null,
      presetId: UUID,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects missing presetId', () => {
    const r = validateOp({ kind: 'preset.apply', afterBlockId: null, parentBrickId: null });
    expect(r.ok).toBe(false);
  });
});

describe('validateOp — brick.* mirror block.*', () => {
  it('rejects bad brickId', () => {
    expect(validateOp({ kind: 'brick.delete', brickId: 'no' }).ok).toBe(false);
    expect(validateOp({ kind: 'brick.move', brickId: 'no', afterBrickId: null }).ok).toBe(false);
    expect(validateOp({ kind: 'brick.update_field', brickId: 'no', fieldPath: 'x', newValue: 1 }).ok).toBe(false);
  });

  it('accepts valid brick.insert', () => {
    const r = validateOp({
      kind: 'brick.insert',
      pageBlockId: UUID,
      brickDefKey: 'left',
      afterBrickId: null,
      content: {},
    });
    expect(r.ok).toBe(true);
  });
});

describe('validateOp — variant content ops', () => {
  it('accepts a valid block.upsert_variant_content', () => {
    const r = validateOp({
      kind: 'block.upsert_variant_content',
      blockId: UUID,
      variantKey: 'v2',
      content: { title: 'Hello' },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects empty variantKey', () => {
    expect(validateOp({
      kind: 'block.upsert_variant_content',
      blockId: UUID,
      variantKey: '',
      content: {},
    }).ok).toBe(false);
  });

  it('rejects variantKey > 64 chars', () => {
    expect(validateOp({
      kind: 'block.upsert_variant_content',
      blockId: UUID,
      variantKey: 'x'.repeat(65),
      content: {},
    }).ok).toBe(false);
  });

  it('rejects non-object content', () => {
    expect(validateOp({
      kind: 'block.upsert_variant_content',
      blockId: UUID,
      variantKey: 'v2',
      content: 'not-an-object',
    }).ok).toBe(false);
  });

  it('accepts a valid brick.upsert_variant_content', () => {
    const r = validateOp({
      kind: 'brick.upsert_variant_content',
      brickId: UUID,
      variantKey: 'urgent',
      content: { label: 'Limited time' },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects bad brickId for brick.upsert_variant_content', () => {
    expect(validateOp({
      kind: 'brick.upsert_variant_content',
      brickId: 'not-a-uuid',
      variantKey: 'v2',
      content: {},
    }).ok).toBe(false);
  });
});
