/**
 * Page CRUD input validation (per spec-sites-module §4.2 + §6.4.1).
 *
 * The validators are pure — they shape an incoming request body into a
 * narrowly-typed insert/update tuple, or return a structured error. The
 * HTTP handler is responsible for tenancy, permission checks, and DB
 * round-trips; these helpers ensure no `: any` / mass-assignment leakage.
 *
 * Tied to the gatewaze-production-readiness skill: see
 * `references/security-boundaries.md` for the *_WRITE_FIELDS allowlist
 * pattern this enforces.
 */

import type { HostKind, PageStatus, ThemeKind } from '../../types/index.js';
import { normalizeRoute, joinRoute, type RouteValidationResult } from './route-validation.js';

// ---------------------------------------------------------------------------
// Allowlists — fields the editor can write. Anything else is dropped.
// ---------------------------------------------------------------------------

export const PAGE_CREATE_FIELDS = [
  'host_kind',
  'host_id',
  'templates_library_id',
  'parent_page_id',
  'slug',
  'full_path',
  'title',
  'template_def_id',
  'wrapper_def_id',
  'status',
  'publish_at',
  'unpublish_at',
  'seo',
  'is_homepage',
] as const;

export const PAGE_UPDATE_FIELDS = [
  'parent_page_id',
  'slug',
  'full_path',
  'title',
  'template_def_id',
  'wrapper_def_id',
  'status',
  'publish_at',
  'unpublish_at',
  'seo',
  'is_homepage',
] as const;

export const PAGE_NEXTJS_CONTENT_FIELDS = [
  'content',
  'content_schema_version',
] as const;

const VALID_STATUSES: ReadonlyArray<PageStatus> = ['draft', 'scheduled', 'published', 'archived'];

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface CreatePageInput {
  host_kind: HostKind;
  host_id: string | null;
  templates_library_id: string;
  parent_page_id: string | null;
  slug: string;
  full_path: string;
  title: string;
  template_def_id: string | null;
  wrapper_def_id: string | null;
  status: PageStatus;
  publish_at: string | null;
  unpublish_at: string | null;
  seo: Record<string, unknown>;
  is_homepage: boolean;
}

export interface UpdatePageInput {
  parent_page_id?: string | null;
  slug?: string;
  full_path?: string;
  title?: string;
  template_def_id?: string | null;
  wrapper_def_id?: string | null;
  status?: PageStatus;
  publish_at?: string | null;
  unpublish_at?: string | null;
  seo?: Record<string, unknown>;
  is_homepage?: boolean;
}

export interface ValidationOk<T> {
  ok: true;
  value: T;
}

export interface ValidationFail {
  ok: false;
  field: string;
  reason: string;
  detail?: string;
}

export type ValidationResult<T> = ValidationOk<T> | ValidationFail;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickFields<T extends string>(
  body: Record<string, unknown>,
  allowed: ReadonlyArray<T>,
): Partial<Record<T, unknown>> {
  const out: Partial<Record<T, unknown>> = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      out[k] = body[k];
    }
  }
  return out;
}

function isUuidLike(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function isIsoDateString(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v.slice(0, 10);
}

function fail(field: string, reason: string, detail?: string): ValidationFail {
  return detail !== undefined
    ? { ok: false, field, reason, detail }
    : { ok: false, field, reason };
}

function validateRouteField(field: string, value: unknown): { ok: true; route: ReturnType<typeof normalizeRoute> & { ok: true } } | ValidationFail {
  const result: RouteValidationResult = normalizeRoute(value);
  if (!result.ok) return fail(field, result.reason, result.detail);
  return { ok: true, route: result };
}

// ---------------------------------------------------------------------------
// Create page validator
// ---------------------------------------------------------------------------

export function validateCreatePage(body: unknown): ValidationResult<CreatePageInput> {
  if (!body || typeof body !== 'object') return fail('body', 'must_be_object');
  const picked = pickFields(body as Record<string, unknown>, PAGE_CREATE_FIELDS);

  if (typeof picked.host_kind !== 'string' || picked.host_kind.length === 0) {
    return fail('host_kind', 'required');
  }
  if (picked.host_id !== null && picked.host_id !== undefined && !isUuidLike(picked.host_id)) {
    return fail('host_id', 'must_be_uuid_or_null');
  }
  if (!isUuidLike(picked.templates_library_id)) {
    return fail('templates_library_id', 'must_be_uuid');
  }
  if (picked.parent_page_id !== null && picked.parent_page_id !== undefined && !isUuidLike(picked.parent_page_id)) {
    return fail('parent_page_id', 'must_be_uuid_or_null');
  }
  if (typeof picked.slug !== 'string' || picked.slug.length === 0) {
    return fail('slug', 'required');
  }
  if (typeof picked.title !== 'string' || picked.title.length === 0) {
    return fail('title', 'required');
  }
  // full_path: optional on create — derived from parent + slug if absent
  let routePath: string;
  if (picked.full_path !== undefined && picked.full_path !== null) {
    const r = validateRouteField('full_path', picked.full_path);
    if (!('route' in r)) return r;
    routePath = r.route.path;
  } else {
    // Editor must supply parent's full_path separately when joinRoute is desired;
    // here we only accept slug as a single segment with leading slash.
    const r = joinRoute('/', picked.slug);
    if (!r.ok) return fail('slug', r.reason, r.detail);
    routePath = r.path;
  }
  if (picked.template_def_id !== null && picked.template_def_id !== undefined && !isUuidLike(picked.template_def_id)) {
    return fail('template_def_id', 'must_be_uuid_or_null');
  }
  if (picked.wrapper_def_id !== null && picked.wrapper_def_id !== undefined && !isUuidLike(picked.wrapper_def_id)) {
    return fail('wrapper_def_id', 'must_be_uuid_or_null');
  }
  const status = (picked.status ?? 'draft') as PageStatus;
  if (!VALID_STATUSES.includes(status)) {
    return fail('status', 'invalid_enum', String(picked.status));
  }
  if (picked.publish_at !== null && picked.publish_at !== undefined && !isIsoDateString(picked.publish_at)) {
    return fail('publish_at', 'must_be_iso_date_or_null');
  }
  if (picked.unpublish_at !== null && picked.unpublish_at !== undefined && !isIsoDateString(picked.unpublish_at)) {
    return fail('unpublish_at', 'must_be_iso_date_or_null');
  }
  const seo = picked.seo ?? {};
  if (typeof seo !== 'object' || Array.isArray(seo)) {
    return fail('seo', 'must_be_object');
  }
  const isHomepage = Boolean(picked.is_homepage ?? false);
  if (isHomepage && routePath !== '/') {
    return fail('is_homepage', 'homepage_requires_root_path');
  }

  return {
    ok: true,
    value: {
      host_kind: picked.host_kind as HostKind,
      host_id: (picked.host_id as string | null | undefined) ?? null,
      templates_library_id: picked.templates_library_id as string,
      parent_page_id: (picked.parent_page_id as string | null | undefined) ?? null,
      slug: picked.slug,
      full_path: routePath,
      title: picked.title,
      template_def_id: (picked.template_def_id as string | null | undefined) ?? null,
      wrapper_def_id: (picked.wrapper_def_id as string | null | undefined) ?? null,
      status,
      publish_at: (picked.publish_at as string | null | undefined) ?? null,
      unpublish_at: (picked.unpublish_at as string | null | undefined) ?? null,
      seo: seo as Record<string, unknown>,
      is_homepage: isHomepage,
    },
  };
}

// ---------------------------------------------------------------------------
// Update page validator
// ---------------------------------------------------------------------------

export function validateUpdatePage(body: unknown): ValidationResult<UpdatePageInput> {
  if (!body || typeof body !== 'object') return fail('body', 'must_be_object');
  const picked = pickFields(body as Record<string, unknown>, PAGE_UPDATE_FIELDS);
  const out: UpdatePageInput = {};

  if ('parent_page_id' in picked) {
    if (picked.parent_page_id !== null && !isUuidLike(picked.parent_page_id)) {
      return fail('parent_page_id', 'must_be_uuid_or_null');
    }
    out.parent_page_id = picked.parent_page_id as string | null;
  }
  if ('slug' in picked) {
    if (typeof picked.slug !== 'string' || picked.slug.length === 0) {
      return fail('slug', 'required');
    }
    out.slug = picked.slug;
  }
  if ('full_path' in picked) {
    const r = validateRouteField('full_path', picked.full_path);
    if (!('route' in r)) return r;
    out.full_path = r.route.path;
  }
  if ('title' in picked) {
    if (typeof picked.title !== 'string' || picked.title.length === 0) {
      return fail('title', 'required');
    }
    out.title = picked.title;
  }
  if ('template_def_id' in picked) {
    if (picked.template_def_id !== null && !isUuidLike(picked.template_def_id)) {
      return fail('template_def_id', 'must_be_uuid_or_null');
    }
    out.template_def_id = picked.template_def_id as string | null;
  }
  if ('wrapper_def_id' in picked) {
    if (picked.wrapper_def_id !== null && !isUuidLike(picked.wrapper_def_id)) {
      return fail('wrapper_def_id', 'must_be_uuid_or_null');
    }
    out.wrapper_def_id = picked.wrapper_def_id as string | null;
  }
  if ('status' in picked) {
    if (!VALID_STATUSES.includes(picked.status as PageStatus)) {
      return fail('status', 'invalid_enum', String(picked.status));
    }
    out.status = picked.status as PageStatus;
  }
  if ('publish_at' in picked) {
    if (picked.publish_at !== null && !isIsoDateString(picked.publish_at)) {
      return fail('publish_at', 'must_be_iso_date_or_null');
    }
    out.publish_at = picked.publish_at as string | null;
  }
  if ('unpublish_at' in picked) {
    if (picked.unpublish_at !== null && !isIsoDateString(picked.unpublish_at)) {
      return fail('unpublish_at', 'must_be_iso_date_or_null');
    }
    out.unpublish_at = picked.unpublish_at as string | null;
  }
  if ('seo' in picked) {
    if (!picked.seo || typeof picked.seo !== 'object' || Array.isArray(picked.seo)) {
      return fail('seo', 'must_be_object');
    }
    out.seo = picked.seo as Record<string, unknown>;
  }
  if ('is_homepage' in picked) {
    out.is_homepage = Boolean(picked.is_homepage);
  }

  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Cross-cutting checks (theme_kind ↔ content)
// ---------------------------------------------------------------------------

/**
 * Mirrors trg_pages_content_matches_kind from migration 006. The DB enforces
 * the invariant authoritatively; this helper is for the API to short-circuit
 * before a DB round-trip when it knows the site's theme_kind.
 */
export function assertContentMatchesThemeKind(args: {
  themeKind: ThemeKind;
  hasContent: boolean;
  hasContentSchemaVersion: boolean;
}): { ok: true } | ValidationFail {
  if (args.themeKind === 'website') {
    if (!args.hasContent || !args.hasContentSchemaVersion) {
      return fail('content', 'required_for_website_theme_kind');
    }
  } else if (args.themeKind === 'email') {
    if (args.hasContent || args.hasContentSchemaVersion) {
      return fail('content', 'forbidden_for_email_theme_kind');
    }
  }
  return { ok: true };
}
