/**
 * Registration → Cvent sync, shared by the worker cron and the admin routes.
 *
 * The ledger is `cvent_registration_sync` (one row per registration that has
 * been attempted). The database-side helpers in migration 003 pick what to do:
 *   - cvent_pending_registrations: active registrations with no ledger row, or
 *     a failed row that is due for another attempt (exponential backoff).
 *   - cvent_changed_contacts: synced rows whose person changed since the sync,
 *     so badge fields (name, title, company) are pushed again.
 *
 * Nothing here talks to Cvent directly; it goes through CventClient so tests
 * can run with fakes for both the database and Cvent.
 */

import { createHash } from 'crypto';
import type { BadgeFields, CventClient } from './cvent-api.js';

export const ACTIVE_STATUSES = ['confirmed', 'pending', 'waitlist', 'waitlisted', 'attended'] as const;

export interface CventEvent {
  id: string;
  event_id: string;
  event_title?: string | null;
  cvent_event_id: string | null;
  cvent_admission_item_id: string | null;
  cvent_sync_enabled: boolean;
}

export interface PendingRegistration {
  registration_id: string;
  person_id: string;
  email: string;
  attributes: Record<string, unknown> | null;
  attempts: number;
}

export interface ChangedContact {
  registration_id: string;
  person_id: string;
  email: string;
  attributes: Record<string, unknown> | null;
  badge_hash: string | null;
}

export interface SyncLimits {
  /** Stop starting new work after this wall-clock time (ms epoch). */
  deadline: number;
  batchSize: number;
  maxAttempts: number;
  pauseMs: number;
}

export interface EventSyncSummary {
  eventId: string;
  attempted: number;
  created: number;
  alreadyExists: number;
  failed: number;
  /** True when the batch filled or the deadline hit, so another run is needed. */
  remaining: boolean;
  errors: string[];
}

export interface ContactPushSummary {
  checked: number;
  updated: number;
  failed: number;
}

/**
 * The slice of supabase-js this file uses, as a structural type so a test can
 * pass a small fake and the lib typechecks without the client's generics.
 */
export interface SyncDb {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string | boolean): {
        maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
        not(column: string, op: string, value: unknown): {
          not(column: string, op: string, value: unknown): Promise<{ data: unknown; error: { message: string } | null }>;
        };
      };
    };
    upsert(row: Record<string, unknown>, opts: { onConflict: string }): Promise<{ error: { message: string } | null }>;
    update(row: Record<string, unknown>): {
      eq(column: string, value: string): Promise<{ error: { message: string } | null }>;
    };
  };
  rpc(fn: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface SyncDeps {
  db: SyncDb;
  cvent: CventClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

const EVENT_COLUMNS = 'id, event_id, event_title, cvent_event_id, cvent_admission_item_id, cvent_sync_enabled';

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

/** Badge fields from a person row, as the registration forms store them. */
export function badgeFields(email: string, attributes: Record<string, unknown> | null | undefined): BadgeFields {
  const a = attributes ?? {};
  return {
    email: email.trim().toLowerCase(),
    firstName: str(a.first_name),
    lastName: str(a.last_name),
    title: str(a.job_title),
    company: str(a.company),
  };
}

/** Stable digest of what was last pushed, so unchanged people are not re-pushed. */
export function badgeHash(f: BadgeFields): string {
  const h = createHash('sha256');
  h.update(JSON.stringify([f.email, f.firstName ?? '', f.lastName ?? '', f.title ?? '', f.company ?? '']));
  return h.digest('hex');
}

export function isEventConfigured(e: CventEvent | null | undefined): e is CventEvent & { cvent_event_id: string; cvent_admission_item_id: string } {
  return !!e && !!str(e.cvent_event_id) && !!str(e.cvent_admission_item_id);
}

export async function loadCventEvent(db: SyncDb, eventUuid: string): Promise<CventEvent | null> {
  const { data, error } = await db.from('events').select(EVENT_COLUMNS).eq('id', eventUuid).maybeSingle();
  if (error) throw new Error(`[cvent] could not load event ${eventUuid}: ${error.message}`);
  return (data as CventEvent | null) ?? null;
}

/** Events with live sync on and both Cvent ids set. */
export async function listSyncEnabledEvents(db: SyncDb): Promise<CventEvent[]> {
  const { data, error } = await db
    .from('events')
    .select(EVENT_COLUMNS)
    .eq('cvent_sync_enabled', true)
    .not('cvent_event_id', 'is', null)
    .not('cvent_admission_item_id', 'is', null);
  if (error) throw new Error(`[cvent] could not list sync-enabled events: ${error.message}`);
  return ((data as CventEvent[] | null) ?? []).filter(isEventConfigured);
}

export async function listPendingRegistrations(db: SyncDb, eventUuid: string, limit: number, maxAttempts: number): Promise<PendingRegistration[]> {
  const { data, error } = await db.rpc('cvent_pending_registrations', {
    p_event_id: eventUuid,
    p_limit: limit,
    p_max_attempts: maxAttempts,
  });
  if (error) throw new Error(`[cvent] cvent_pending_registrations failed: ${error.message}`);
  return (data as PendingRegistration[] | null) ?? [];
}

export async function eventSyncStatus(db: SyncDb, eventUuid: string): Promise<Record<string, unknown>> {
  const { data, error } = await db.rpc('cvent_event_sync_status', { p_event_id: eventUuid });
  if (error) throw new Error(`[cvent] cvent_event_sync_status failed: ${error.message}`);
  return (data as Record<string, unknown> | null) ?? {};
}

/**
 * Push one registration to Cvent and record the outcome in the ledger.
 * Never throws: a failure is a 'failed' row with the error text.
 */
export async function syncOneRegistration(
  deps: SyncDeps,
  event: CventEvent & { cvent_event_id: string; cvent_admission_item_id: string },
  reg: PendingRegistration,
): Promise<{ success: boolean; action?: string; error?: string }> {
  const now = deps.now ?? Date.now;
  const fields = badgeFields(reg.email, reg.attributes);
  const result = await deps.cvent.syncRegistrant(event.cvent_event_id, event.cvent_admission_item_id, fields);

  const row: Record<string, unknown> = {
    registration_id: reg.registration_id,
    event_id: event.id,
    person_id: reg.person_id,
    attempts: (reg.attempts ?? 0) + 1,
  };
  if (result.success) {
    Object.assign(row, {
      status: 'synced',
      cvent_contact_id: result.contactId ?? null,
      cvent_attendee_id: result.attendeeId ?? null,
      badge_hash: badgeHash(fields),
      last_error: null,
      synced_at: new Date(now()).toISOString(),
    });
  } else {
    Object.assign(row, {
      status: 'failed',
      last_error: (result.error ?? 'unknown error').slice(0, 500),
    });
  }

  const { error } = await deps.db.from('cvent_registration_sync').upsert(row, { onConflict: 'registration_id' });
  if (error) deps.log?.(`[cvent] ledger write failed for ${reg.registration_id}: ${error.message}`);

  return { success: result.success, action: result.action, error: result.error };
}

/**
 * One batch for one event. Sequential with a pause between calls, since the
 * Cvent API rate-limits per account, and bounded by the deadline so a large
 * backfill is spread across runs rather than holding a worker slot.
 */
export async function syncEvent(deps: SyncDeps, event: CventEvent, limits: SyncLimits): Promise<EventSyncSummary> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const summary: EventSyncSummary = { eventId: event.id, attempted: 0, created: 0, alreadyExists: 0, failed: 0, remaining: false, errors: [] };

  if (!isEventConfigured(event)) {
    summary.errors.push('event has no Cvent event id or admission item');
    return summary;
  }

  const pending = await listPendingRegistrations(deps.db, event.id, limits.batchSize, limits.maxAttempts);
  summary.remaining = pending.length >= limits.batchSize;

  for (const reg of pending) {
    if (now() > limits.deadline) {
      summary.remaining = true;
      break;
    }
    const r = await syncOneRegistration(deps, event, reg);
    summary.attempted++;
    if (r.success) {
      if (r.action === 'already_exists') summary.alreadyExists++;
      else summary.created++;
    } else {
      summary.failed++;
      if (summary.errors.length < 10) summary.errors.push(`${reg.email}: ${r.error ?? 'unknown error'}`);
    }
    if (limits.pauseMs > 0) await sleep(limits.pauseMs);
  }

  return summary;
}

/**
 * Re-push badge fields for synced registrations whose person row changed.
 * A change that does not touch a badge field just refreshes synced_at.
 */
export async function pushChangedContacts(deps: SyncDeps, event: CventEvent, limits: SyncLimits): Promise<ContactPushSummary> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const out: ContactPushSummary = { checked: 0, updated: 0, failed: 0 };

  const { data, error } = await deps.db.rpc('cvent_changed_contacts', { p_event_id: event.id, p_limit: limits.batchSize });
  if (error) throw new Error(`[cvent] cvent_changed_contacts failed: ${error.message}`);

  for (const c of (data as ChangedContact[] | null) ?? []) {
    if (now() > limits.deadline) break;
    out.checked++;
    const fields = badgeFields(c.email, c.attributes);
    const hash = badgeHash(fields);
    const stamp = new Date(now()).toISOString();

    if (hash === c.badge_hash) {
      await deps.db.from('cvent_registration_sync').update({ synced_at: stamp }).eq('registration_id', c.registration_id);
      continue;
    }

    const r = await deps.cvent.updateContact(fields);
    if (r.success) {
      out.updated++;
      await deps.db
        .from('cvent_registration_sync')
        .update({ badge_hash: hash, cvent_contact_id: r.contactId ?? null, synced_at: stamp, last_error: null })
        .eq('registration_id', c.registration_id);
    } else {
      out.failed++;
      // Keep the row 'synced' (the attendee exists); record why the update
      // failed and move synced_at on so one bad contact is not retried every
      // minute forever.
      await deps.db
        .from('cvent_registration_sync')
        .update({ last_error: (r.error ?? 'update failed').slice(0, 500), synced_at: stamp })
        .eq('registration_id', c.registration_id);
      deps.log?.(`[cvent] contact update failed for ${fields.email}: ${r.error}`);
    }
    if (limits.pauseMs > 0) await sleep(limits.pauseMs);
  }

  return out;
}
