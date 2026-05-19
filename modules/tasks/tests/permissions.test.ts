import { describe, it, expect } from 'vitest';
import { canRead, canEdit, canManage } from '../lib/permissions';

describe('permissions', () => {
  it('owner can read/edit/manage', () => {
    expect(canRead('owner')).toBe(true);
    expect(canEdit('owner')).toBe(true);
    expect(canManage('owner')).toBe(true);
  });

  it('editor can read/edit, not manage', () => {
    expect(canRead('editor')).toBe(true);
    expect(canEdit('editor')).toBe(true);
    expect(canManage('editor')).toBe(false);
  });

  it('viewer can read only', () => {
    expect(canRead('viewer')).toBe(true);
    expect(canEdit('viewer')).toBe(false);
    expect(canManage('viewer')).toBe(false);
  });

  it('null role denies all', () => {
    expect(canRead(null)).toBe(false);
    expect(canEdit(null)).toBe(false);
    expect(canManage(null)).toBe(false);
  });
});
