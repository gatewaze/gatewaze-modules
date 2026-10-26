import { describe, expect, it } from 'vitest';
import type { CventClient } from '../cvent-api';
import {
  badgeFields,
  badgeHash,
  isEventConfigured,
  pushChangedContacts,
  syncEvent,
  syncOneRegistration,
  type CventEvent,
  type SyncDb,
} from '../sync';

const event: CventEvent = {
  id: 'e-uuid',
  event_id: '7afa6e',
  event_title: 'Voice Agents Forum',
  cvent_event_id: 'cv-evt',
  cvent_admission_item_id: 'cv-adm',
  cvent_sync_enabled: true,
};

interface FakeDb extends SyncDb {
  upserts: Array<Record<string, unknown>>;
  updates: Array<{ row: Record<string, unknown>; registration_id: string }>;
}

/** In-memory stand-in for the two RPCs and the ledger writes the lib uses. */
function fakeDb(opts: { pending?: unknown[]; changed?: unknown[] } = {}): FakeDb {
  const upserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ row: Record<string, unknown>; registration_id: string }> = [];
  const db: FakeDb = {
    upserts,
    updates,
    from(table: string) {
      if (table !== 'cvent_registration_sync') throw new Error(`unexpected table ${table}`);
      return {
        select: () => {
          throw new Error('not used');
        },
        upsert: async (row: Record<string, unknown>) => {
          upserts.push(row);
          return { error: null };
        },
        update: (row: Record<string, unknown>) => ({
          eq: async (_col: string, registration_id: string) => {
            updates.push({ row, registration_id });
            return { error: null };
          },
        }),
      };
    },
    async rpc(fn: string) {
      if (fn === 'cvent_pending_registrations') return { data: opts.pending ?? [], error: null };
      if (fn === 'cvent_changed_contacts') return { data: opts.changed ?? [], error: null };
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  return db;
}

function fakeCvent(script: Record<string, { success: boolean; action?: 'created' | 'already_exists' | 'updated'; error?: string; contactId?: string }>) {
  const synced: string[] = [];
  const updated: string[] = [];
  const cvent: CventClient = {
    async listAdmissionItems() {
      return { success: true, items: [] };
    },
    async syncRegistrant(_e, _a, f) {
      synced.push(f.email);
      return script[f.email] ?? { success: true, action: 'created', contactId: `c-${f.email}` };
    },
    async updateContact(f) {
      updated.push(f.email);
      return script[f.email] ?? { success: true, action: 'updated', contactId: `c-${f.email}` };
    },
  };
  return { cvent, synced, updated };
}

const limits = { deadline: Number.MAX_SAFE_INTEGER, batchSize: 100, maxAttempts: 5, pauseMs: 0 };

describe('badgeFields / badgeHash', () => {
  it('reads the registration attribute keys and normalises the email', () => {
    expect(badgeFields(' Ada@X.com ', { first_name: 'Ada', last_name: ' Lovelace ', job_title: 'CTO', company: 'Analytical' })).toEqual({
      email: 'ada@x.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      title: 'CTO',
      company: 'Analytical',
    });
    expect(badgeFields('a@b.com', null)).toEqual({ email: 'a@b.com', firstName: null, lastName: null, title: null, company: null });
  });

  it('hashes the same fields to the same value and a changed field to a different one', () => {
    const a = badgeHash(badgeFields('a@b.com', { first_name: 'A', company: 'X' }));
    const b = badgeHash(badgeFields('a@b.com', { first_name: 'A', company: 'X', unrelated: 1 }));
    const c = badgeHash(badgeFields('a@b.com', { first_name: 'A', company: 'Y' }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('isEventConfigured', () => {
  it('needs both Cvent ids', () => {
    expect(isEventConfigured(event)).toBe(true);
    expect(isEventConfigured({ ...event, cvent_admission_item_id: ' ' })).toBe(false);
    expect(isEventConfigured({ ...event, cvent_event_id: null })).toBe(false);
    expect(isEventConfigured(null)).toBe(false);
  });
});

describe('syncOneRegistration', () => {
  it('writes a synced ledger row with the badge hash on success', async () => {
    const db = fakeDb();
    const { cvent } = fakeCvent({});
    const reg = { registration_id: 'r1', person_id: 'p1', email: 'ada@x.com', attributes: { first_name: 'Ada' }, attempts: 0 };

    const r = await syncOneRegistration({ db, cvent, now: () => 1_700_000_000_000 }, event, reg);

    expect(r).toEqual({ success: true, action: 'created', error: undefined });
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]).toMatchObject({
      registration_id: 'r1',
      event_id: 'e-uuid',
      person_id: 'p1',
      status: 'synced',
      cvent_contact_id: 'c-ada@x.com',
      attempts: 1,
      last_error: null,
      badge_hash: badgeHash(badgeFields('ada@x.com', { first_name: 'Ada' })),
      synced_at: new Date(1_700_000_000_000).toISOString(),
    });
  });

  it('writes a failed row with the error and a bumped attempt count', async () => {
    const db = fakeDb();
    const { cvent } = fakeCvent({ 'bad@x.com': { success: false, error: 'POST /attendees failed (400)' } });
    const reg = { registration_id: 'r2', person_id: 'p2', email: 'bad@x.com', attributes: null, attempts: 2 };

    const r = await syncOneRegistration({ db, cvent }, event, reg);

    expect(r.success).toBe(false);
    expect(db.upserts[0]).toMatchObject({ registration_id: 'r2', status: 'failed', attempts: 3, last_error: 'POST /attendees failed (400)' });
    expect(db.upserts[0]).not.toHaveProperty('synced_at');
  });
});

describe('syncEvent', () => {
  const pending = [
    { registration_id: 'r1', person_id: 'p1', email: 'one@x.com', attributes: {}, attempts: 0 },
    { registration_id: 'r2', person_id: 'p2', email: 'two@x.com', attributes: {}, attempts: 0 },
    { registration_id: 'r3', person_id: 'p3', email: 'three@x.com', attributes: {}, attempts: 1 },
  ];

  it('pushes every pending registration and tallies the outcomes', async () => {
    const db = fakeDb({ pending });
    const { cvent, synced } = fakeCvent({
      'two@x.com': { success: true, action: 'already_exists' },
      'three@x.com': { success: false, error: 'boom' },
    });

    const s = await syncEvent({ db, cvent }, event, limits);

    expect(synced).toEqual(['one@x.com', 'two@x.com', 'three@x.com']);
    expect(s).toMatchObject({ eventId: 'e-uuid', attempted: 3, created: 1, alreadyExists: 1, failed: 1, remaining: false });
    expect(s.errors).toEqual(['three@x.com: boom']);
    expect(db.upserts.map((u) => u.status)).toEqual(['synced', 'synced', 'failed']);
  });

  it('stops at the deadline and reports more remaining', async () => {
    const db = fakeDb({ pending });
    const { cvent, synced } = fakeCvent({});
    let t = 0;
    const s = await syncEvent({ db, cvent, now: () => (t += 10) }, event, { ...limits, deadline: 15 });
    // First check at t=10 passes, second at t=20 is past the deadline.
    expect(synced).toEqual(['one@x.com']);
    expect(s.attempted).toBe(1);
    expect(s.remaining).toBe(true);
  });

  it('reports more remaining when the batch came back full', async () => {
    const db = fakeDb({ pending });
    const { cvent } = fakeCvent({});
    const s = await syncEvent({ db, cvent }, event, { ...limits, batchSize: 3 });
    expect(s.remaining).toBe(true);
  });

  it('refuses an event without Cvent ids and touches nothing', async () => {
    const db = fakeDb({ pending });
    const { cvent, synced } = fakeCvent({});
    const s = await syncEvent({ db, cvent }, { ...event, cvent_admission_item_id: null }, limits);
    expect(synced).toEqual([]);
    expect(s.errors[0]).toMatch(/no Cvent event id or admission item/);
    expect(db.upserts).toHaveLength(0);
  });
});

describe('pushChangedContacts', () => {
  it('re-pushes only people whose badge fields changed, and refreshes the rest', async () => {
    const same = badgeFields('same@x.com', { first_name: 'S' });
    const db = fakeDb({
      changed: [
        { registration_id: 'r1', person_id: 'p1', email: 'same@x.com', attributes: { first_name: 'S' }, badge_hash: badgeHash(same) },
        { registration_id: 'r2', person_id: 'p2', email: 'moved@x.com', attributes: { first_name: 'M', company: 'New' }, badge_hash: 'stale' },
      ],
    });
    const { cvent, updated } = fakeCvent({});

    const out = await pushChangedContacts({ db, cvent, now: () => 5_000 }, event, limits);

    expect(updated).toEqual(['moved@x.com']);
    expect(out).toEqual({ checked: 2, updated: 1, failed: 0 });
    const byReg = Object.fromEntries(db.updates.map((u) => [u.registration_id, u.row]));
    expect(byReg.r1).toEqual({ synced_at: new Date(5_000).toISOString() });
    expect(byReg.r2).toMatchObject({
      badge_hash: badgeHash(badgeFields('moved@x.com', { first_name: 'M', company: 'New' })),
      cvent_contact_id: 'c-moved@x.com',
      last_error: null,
    });
  });

  it('records a failed update without demoting the row', async () => {
    const db = fakeDb({
      changed: [{ registration_id: 'r9', person_id: 'p9', email: 'gone@x.com', attributes: { first_name: 'G' }, badge_hash: 'old' }],
    });
    const { cvent } = fakeCvent({ 'gone@x.com': { success: false, error: 'Contact not found in Cvent for gone@x.com' } });

    const out = await pushChangedContacts({ db, cvent }, event, limits);

    expect(out).toEqual({ checked: 1, updated: 0, failed: 1 });
    expect(db.updates[0].row).toMatchObject({ last_error: 'Contact not found in Cvent for gone@x.com' });
    expect(db.updates[0].row).not.toHaveProperty('status');
  });
});
