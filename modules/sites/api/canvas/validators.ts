/**
 * Narrow validators for canvas op envelopes. Per spec-sites-wysiwyg-builder
 * §5.3 + §7.3.
 *
 * Pattern: discriminated-union validation with no `: any` and no Zod (matches
 * the existing platform pattern in lib/page-lifecycle/validate.ts). Each op
 * kind gets its own field-allowlist; `req.body` never flows to a write
 * unmediated.
 */

import type { CanvasOp, OpEnvelope } from '../../lib/canvas-render/types.js';
import { canvasConfig } from './canvas-config.js';

export type ValidationFail = {
  ok: false;
  reason: string;
  field?: string;
  index?: number;
  detail?: Record<string, unknown>;
};

export type ValidationOk<T> = { ok: true; value: T };

export type ValidationResult<T> = ValidationOk<T> | ValidationFail;

function fail(reason: string, extra: Partial<ValidationFail> = {}): ValidationFail {
  return { ok: false, reason, ...extra };
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isUuidLike(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
}

function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Number.isInteger(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateEnvelope(body: unknown): ValidationResult<OpEnvelope> {
  if (!isPlainObject(body)) return fail('body must be an object');

  if (!Array.isArray(body.ops)) return fail('ops must be an array', { field: 'ops' });
  if (body.ops.length === 0) return fail('ops cannot be empty', { field: 'ops' });
  if (body.ops.length > canvasConfig.opBatchMax) {
    return fail(`ops exceeds ${canvasConfig.opBatchMax}`, { field: 'ops' });
  }

  if (!isNonNegativeNumber(body.baseVersion)) {
    return fail('baseVersion must be a non-negative integer', { field: 'baseVersion' });
  }
  if (!isString(body.clientToken) || body.clientToken.length < 16 || body.clientToken.length > 64) {
    return fail('clientToken must be a string 16..64 chars', { field: 'clientToken' });
  }
  if (!isUuidLike(body.idempotencyKey)) {
    return fail('idempotencyKey must be a UUIDv4', { field: 'idempotencyKey' });
  }

  const validatedOps: CanvasOp[] = [];
  for (let i = 0; i < body.ops.length; i++) {
    const op = body.ops[i];
    const r = validateOp(op);
    if (!r.ok) return { ...r, index: i };
    validatedOps.push(r.value);
  }

  return {
    ok: true,
    value: {
      ops: validatedOps,
      baseVersion: body.baseVersion,
      clientToken: body.clientToken,
      idempotencyKey: body.idempotencyKey,
    },
  };
}

export function validateOp(op: unknown): ValidationResult<CanvasOp> {
  if (!isPlainObject(op)) return fail('op must be an object');
  const kind = op.kind;
  if (!isString(kind)) return fail('op.kind must be a string', { field: 'kind' });

  switch (kind) {
    case 'block.insert':
      return validateBlockInsert(op);
    case 'block.move':
      return validateBlockMove(op);
    case 'block.delete':
      return validateBlockDelete(op);
    case 'block.update_field':
      return validateBlockUpdateField(op);
    case 'block.set_variant':
      return validateBlockSetVariant(op);
    case 'block.upsert_variant_content':
      return validateBlockUpsertVariantContent(op);
    case 'brick.insert':
      return validateBrickInsert(op);
    case 'brick.move':
      return validateBrickMove(op);
    case 'brick.delete':
      return validateBrickDelete(op);
    case 'brick.update_field':
      return validateBrickUpdateField(op);
    case 'brick.upsert_variant_content':
      return validateBrickUpsertVariantContent(op);
    case 'preset.apply':
      return validatePresetApply(op);
    default:
      return fail(`unknown op kind: ${kind}`, { field: 'kind' });
  }
}

function validateBlockInsert(op: Record<string, unknown>): ValidationResult<CanvasOp> {
  if (op.afterBlockId !== null && !isUuidLike(op.afterBlockId)) {
    return fail('afterBlockId must be uuid or null', { field: 'afterBlockId' });
  }
  if (op.parentBrickId !== null && !isUuidLike(op.parentBrickId)) {
    return fail('parentBrickId must be uuid or null', { field: 'parentBrickId' });
  }
  if (!isString(op.blockDefKey) || op.blockDefKey.length === 0) {
    return fail('blockDefKey required', { field: 'blockDefKey' });
  }
  if (!isPlainObject(op.content)) {
    return fail('content must be an object', { field: 'content' });
  }
  return {
    ok: true,
    value: {
      kind: 'block.insert',
      afterBlockId: op.afterBlockId as string | null,
      parentBrickId: op.parentBrickId as string | null,
      blockDefKey: op.blockDefKey,
      content: op.content,
    },
  };
}

function validateBlockMove(op: Record<string, unknown>): ValidationResult<CanvasOp> {
  if (!isUuidLike(op.blockId)) return fail('blockId required', { field: 'blockId' });
  if (op.afterBlockId !== null && !isUuidLike(op.afterBlockId)) {
    return fail('afterBlockId must be uuid or null', { field: 'afterBlockId' });
  }
  if (op.parentBrickId !== null && !isUuidLike(op.parentBrickId)) {
    return fail('parentBrickId must be uuid or null', { field: 'parentBrickId' });
  }
  return {
    ok: true,
    value: {
      kind: 'block.move',
      blockId: op.blockId,
      afterBlockId: op.afterBlockId as string | null,
      parentBrickId: op.parentBrickId as string | null,
    },
  };
}

function validateBlockDelete(op: Record<string, unknown>): ValidationResult<CanvasOp> {
  if (!isUuidLike(op.blockId)) return fail('blockId required', { field: 'blockId' });
  return { ok: true, value: { kind: 'block.delete', blockId: op.blockId } };
}

function validateBlockUpdateField(op: Record<string, unknown>): ValidationResult<CanvasOp> {
  if (!isUuidLike(op.blockId)) return fail('blockId required', { field: 'blockId' });
  if (!isString(op.fieldPath) || op.fieldPath.length === 0) {
    return fail('fieldPath required', { field: 'fieldPath' });
  }
  // newValue is `unknown` by design — schema validation happens server-side
  // against the block_def's JSON Schema in op-handlers.ts, not here.
  return {
    ok: true,
    value: {
      kind: 'block.update_field',
      blockId: op.blockId,
      fieldPath: op.fieldPath,
      newValue: op.newValue,
    },
  };
}

function validateBlockSetVariant(op: Record<string, unknown>): ValidationResult<CanvasOp> {
  if (!isUuidLike(op.blockId)) return fail('blockId required', { field: 'blockId' });
  if (!isString(op.variantKey) || op.variantKey.length === 0) {
    return fail('variantKey required', { field: 'variantKey' });
  }
  if (op.variantKey.length > 64) {
    return fail('variantKey must be ≤64 chars', { field: 'variantKey' });
  }
  return {
    ok: true,
    value: { kind: 'block.set_variant', blockId: op.blockId, variantKey: op.variantKey },
  };
}

function validateBlockUpsertVariantContent(op: Record<string, unknown>): ValidationResult<CanvasOp> {
  if (!isUuidLike(op.blockId)) return fail('blockId required', { field: 'blockId' });
  if (!isString(op.variantKey) || op.variantKey.length === 0 || op.variantKey.length > 64) {
    return fail('variantKey must be 1..64 chars', { field: 'variantKey' });
  }
  if (!isPlainObject(op.content)) {
    return fail('content must be an object', { field: 'content' });
  }
  return {
    ok: true,
    value: {
      kind: 'block.upsert_variant_content',
      blockId: op.blockId,
      variantKey: op.variantKey,
      content: op.content,
    },
  };
}

function validateBrickInsert(op: Record<string, unknown>): ValidationResult<CanvasOp> {
  if (!isUuidLike(op.pageBlockId)) return fail('pageBlockId required', { field: 'pageBlockId' });
  if (!isString(op.brickDefKey) || op.brickDefKey.length === 0) {
    return fail('brickDefKey required', { field: 'brickDefKey' });
  }
  if (op.afterBrickId !== null && !isUuidLike(op.afterBrickId)) {
    return fail('afterBrickId must be uuid or null', { field: 'afterBrickId' });
  }
  if (!isPlainObject(op.content)) {
    return fail('content must be an object', { field: 'content' });
  }
  return {
    ok: true,
    value: {
      kind: 'brick.insert',
      pageBlockId: op.pageBlockId,
      brickDefKey: op.brickDefKey,
      afterBrickId: op.afterBrickId as string | null,
      content: op.content,
    },
  };
}

function validateBrickMove(op: Record<string, unknown>): ValidationResult<CanvasOp> {
  if (!isUuidLike(op.brickId)) return fail('brickId required', { field: 'brickId' });
  if (op.afterBrickId !== null && !isUuidLike(op.afterBrickId)) {
    return fail('afterBrickId must be uuid or null', { field: 'afterBrickId' });
  }
  return {
    ok: true,
    value: { kind: 'brick.move', brickId: op.brickId, afterBrickId: op.afterBrickId as string | null },
  };
}

function validateBrickDelete(op: Record<string, unknown>): ValidationResult<CanvasOp> {
  if (!isUuidLike(op.brickId)) return fail('brickId required', { field: 'brickId' });
  return { ok: true, value: { kind: 'brick.delete', brickId: op.brickId } };
}

function validateBrickUpdateField(op: Record<string, unknown>): ValidationResult<CanvasOp> {
  if (!isUuidLike(op.brickId)) return fail('brickId required', { field: 'brickId' });
  if (!isString(op.fieldPath) || op.fieldPath.length === 0) {
    return fail('fieldPath required', { field: 'fieldPath' });
  }
  return {
    ok: true,
    value: {
      kind: 'brick.update_field',
      brickId: op.brickId,
      fieldPath: op.fieldPath,
      newValue: op.newValue,
    },
  };
}

function validateBrickUpsertVariantContent(op: Record<string, unknown>): ValidationResult<CanvasOp> {
  if (!isUuidLike(op.brickId)) return fail('brickId required', { field: 'brickId' });
  if (!isString(op.variantKey) || op.variantKey.length === 0 || op.variantKey.length > 64) {
    return fail('variantKey must be 1..64 chars', { field: 'variantKey' });
  }
  if (!isPlainObject(op.content)) {
    return fail('content must be an object', { field: 'content' });
  }
  return {
    ok: true,
    value: {
      kind: 'brick.upsert_variant_content',
      brickId: op.brickId,
      variantKey: op.variantKey,
      content: op.content,
    },
  };
}

function validatePresetApply(op: Record<string, unknown>): ValidationResult<CanvasOp> {
  if (!isUuidLike(op.presetId)) return fail('presetId required', { field: 'presetId' });
  if (op.afterBlockId !== null && !isUuidLike(op.afterBlockId)) {
    return fail('afterBlockId must be uuid or null', { field: 'afterBlockId' });
  }
  if (op.parentBrickId !== null && !isUuidLike(op.parentBrickId)) {
    return fail('parentBrickId must be uuid or null', { field: 'parentBrickId' });
  }
  return {
    ok: true,
    value: {
      kind: 'preset.apply',
      afterBlockId: op.afterBlockId as string | null,
      parentBrickId: op.parentBrickId as string | null,
      presetId: op.presetId,
    },
  };
}
