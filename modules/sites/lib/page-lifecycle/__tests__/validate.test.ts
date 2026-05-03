import { describe, expect, it } from 'vitest';
import {
  validateCreatePage,
  validateUpdatePage,
  assertContentMatchesThemeKind,
} from '../validate.js';

const UUID = '00000000-1111-2222-3333-444444444444';

describe('validateCreatePage()', () => {
  it('accepts a minimal valid page', () => {
    const r = validateCreatePage({
      host_kind: 'site',
      host_id: UUID,
      templates_library_id: UUID,
      slug: 'about',
      title: 'About',
      full_path: '/about',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.full_path).toBe('/about');
    expect(r.value.status).toBe('draft');
    expect(r.value.is_homepage).toBe(false);
  });

  it('drops fields not on the allowlist', () => {
    const r = validateCreatePage({
      host_kind: 'site',
      host_id: UUID,
      templates_library_id: UUID,
      slug: 'a',
      title: 'A',
      full_path: '/a',
      content: { hero: 'pwn' },              // forbidden — must be set via batch endpoint
      created_by: 'someone-else',           // forbidden — server sets
      version: 999,                          // forbidden — bumped by trigger
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value)).not.toContain('content');
    expect(Object.keys(r.value)).not.toContain('created_by');
    expect(Object.keys(r.value)).not.toContain('version');
  });

  it('derives full_path from slug when omitted', () => {
    const r = validateCreatePage({
      host_kind: 'site',
      host_id: UUID,
      templates_library_id: UUID,
      slug: 'about',
      title: 'About',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.full_path).toBe('/about');
  });

  it('rejects malformed UUIDs', () => {
    const r = validateCreatePage({
      host_kind: 'site',
      host_id: UUID,
      templates_library_id: 'not-a-uuid',
      slug: 'a', title: 'A', full_path: '/a',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.field).toBe('templates_library_id');
  });

  it('rejects invalid status enum', () => {
    const r = validateCreatePage({
      host_kind: 'site', host_id: UUID, templates_library_id: UUID,
      slug: 'a', title: 'A', full_path: '/a', status: 'live',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.field).toBe('status');
  });

  it('rejects is_homepage=true with non-root path', () => {
    const r = validateCreatePage({
      host_kind: 'site', host_id: UUID, templates_library_id: UUID,
      slug: 'about', title: 'About', full_path: '/about', is_homepage: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.field).toBe('is_homepage');
  });

  it('accepts is_homepage=true at /', () => {
    const r = validateCreatePage({
      host_kind: 'site', host_id: UUID, templates_library_id: UUID,
      slug: 'home', title: 'Home', full_path: '/', is_homepage: true,
    });
    expect(r.ok).toBe(true);
  });
});

describe('validateUpdatePage()', () => {
  it('accepts a partial update with title only', () => {
    const r = validateUpdatePage({ title: 'New Title' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ title: 'New Title' });
  });

  it('drops fields not on the update allowlist', () => {
    const r = validateUpdatePage({
      title: 'New Title',
      host_kind: 'event',           // not updatable
      templates_library_id: UUID,    // not updatable post-creation
      version: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ title: 'New Title' });
  });

  it('rejects non-object body', () => {
    const r = validateUpdatePage('nope');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.field).toBe('body');
  });

  it('rejects null seo', () => {
    const r = validateUpdatePage({ seo: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.field).toBe('seo');
  });

  it('accepts publish_at = null (clearing schedule)', () => {
    const r = validateUpdatePage({ publish_at: null });
    expect(r.ok).toBe(true);
  });
});

describe('assertContentMatchesThemeKind()', () => {
  it("requires content+schemaVersion for website", () => {
    expect(assertContentMatchesThemeKind({ themeKind: 'website', hasContent: true, hasContentSchemaVersion: true }).ok).toBe(true);
    expect(assertContentMatchesThemeKind({ themeKind: 'website', hasContent: false, hasContentSchemaVersion: true }).ok).toBe(false);
    expect(assertContentMatchesThemeKind({ themeKind: 'website', hasContent: true, hasContentSchemaVersion: false }).ok).toBe(false);
  });

  it("forbids content for email", () => {
    expect(assertContentMatchesThemeKind({ themeKind: 'email', hasContent: false, hasContentSchemaVersion: false }).ok).toBe(true);
    expect(assertContentMatchesThemeKind({ themeKind: 'email', hasContent: true, hasContentSchemaVersion: false }).ok).toBe(false);
    expect(assertContentMatchesThemeKind({ themeKind: 'email', hasContent: false, hasContentSchemaVersion: true }).ok).toBe(false);
  });
});
