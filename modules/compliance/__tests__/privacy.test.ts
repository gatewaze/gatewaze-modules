import { describe, it, expect } from 'vitest';
import {
  normaliseEmails, parseCreateInput, queueExecute, queuePreview, publicView, reportMarkdown,
  emailSha256, PrivacyError, type Actor,
} from '../lib/privacy';

const actor: Actor = { via: 'api', label: 'test-key' };
const ID = '11111111-2222-4333-8444-555555555555';

/** Minimal stand-in for the supabase-js query builder. */
function fakeSupabase(row: Record<string, unknown>, opts: { claim?: boolean } = {}) {
  const calls: Array<{ op: string; values?: unknown; filters: unknown[] }> = [];
  const builder = (op: string, values?: unknown) => {
    const call = { op, values, filters: [] as unknown[] };
    calls.push(call);
    const b: Record<string, unknown> = {};
    for (const m of ['eq', 'in', 'contains', 'order', 'limit']) {
      b[m] = (...args: unknown[]) => { call.filters.push([m, ...args]); return b; };
    }
    b.select = () => {
      if (op === 'update') return Promise.resolve({ data: opts.claim === false ? [] : [{ id: ID }], error: null });
      return b;
    };
    b.maybeSingle = () => Promise.resolve({ data: row, error: null });
    b.single = () => Promise.resolve({ data: row, error: null });
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
    return b;
  };
  return {
    calls,
    from: () => ({
      select: () => builder('select'),
      update: (v: unknown) => builder('update', v),
      insert: (v: unknown) => builder('insert', v),
    }),
  };
}

const readyRow = (over: Record<string, unknown> = {}) => ({
  id: ID,
  request_type: 'data_deletion',
  status: 'pending',
  subject_email: 'person@example.com',
  subject_emails: ['person@example.com'],
  plan_status: 'ready',
  plan_built_at: new Date().toISOString(),
  plan: { summary: { rows: 4 }, tables: [], blockers: [], warnings: [] },
  execute_status: 'none',
  executed_at: null,
  redacted_at: null,
  ...over,
});

describe('normaliseEmails', () => {
  it('lowercases, trims and dedupes', () => {
    expect(normaliseEmails([' A@Example.com', 'a@example.com', 'b@example.org'])).toEqual(['a@example.com', 'b@example.org']);
  });
  it('splits a string on commas and spaces', () => {
    expect(normaliseEmails('a@example.com, b@example.org')).toEqual(['a@example.com', 'b@example.org']);
  });
  it('rejects anything that could open a PostgREST filter', () => {
    for (const bad of ['a@x.com),email.neq.(', 'a(b)@x.com', 'not-an-email', '"a"@x.com']) {
      expect(() => normaliseEmails([bad])).toThrow(PrivacyError);
    }
  });
  it('requires at least one and at most ten', () => {
    expect(() => normaliseEmails([])).toThrow(/at least one/);
    expect(() => normaliseEmails(Array.from({ length: 11 }, (_, i) => `p${i}@example.com`))).toThrow(/at most/);
  });
});

describe('parseCreateInput', () => {
  it('ignores fields outside the allowlist', () => {
    const input = parseCreateInput({ emails: ['a@example.com'], status: 'completed', executed_at: 'now', id: 'x' });
    expect(Object.keys(input).sort()).toEqual(['due_at', 'emails', 'notes', 'request_type', 'requested_at', 'requester_email', 'source']);
  });
  it('defaults to an erasure due one month after receipt', () => {
    const input = parseCreateInput({ email: 'a@example.com', requested_at: '2026-10-13T18:45:50Z' });
    expect(input.request_type).toBe('data_deletion');
    expect(input.due_at).toBe('2026-11-13T18:45:50.000Z');
  });
  it('rejects an unknown request type', () => {
    expect(() => parseCreateInput({ emails: ['a@example.com'], request_type: 'drop_tables' })).toThrow(/request_type/);
  });
  it('rejects a received date in the future', () => {
    expect(() => parseCreateInput({ emails: ['a@example.com'], requested_at: '2999-01-01' })).toThrow(/future/);
  });
});

describe('queueExecute', () => {
  it('requires the typed confirmation to match a request address', async () => {
    const sb = fakeSupabase(readyRow());
    await expect(queueExecute(sb, undefined, ID, 'someone-else@example.com', actor)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  });
  it('refuses without a preview', async () => {
    const sb = fakeSupabase(readyRow({ plan_status: 'none', plan: null }));
    await expect(queueExecute(sb, undefined, ID, 'person@example.com', actor)).rejects.toMatchObject({ code: 'PREVIEW_REQUIRED' });
  });
  it('refuses a stale preview', async () => {
    const sb = fakeSupabase(readyRow({ plan_built_at: new Date(Date.now() - 25 * 3600_000).toISOString() }));
    await expect(queueExecute(sb, undefined, ID, 'person@example.com', actor)).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
  });
  it('refuses a preview with blockers', async () => {
    const sb = fakeSupabase(readyRow({ plan: { tables: [], blockers: [{ kind: 'unregistered_link' }], warnings: [] } }));
    await expect(queueExecute(sb, undefined, ID, 'person@example.com', actor)).rejects.toMatchObject({ code: 'BLOCKED' });
  });
  it('refuses a request that was already erased', async () => {
    const sb = fakeSupabase(readyRow({ execute_status: 'erased', executed_at: new Date().toISOString() }));
    await expect(queueExecute(sb, undefined, ID, 'person@example.com', actor)).rejects.toMatchObject({ code: 'ALREADY_ERASED' });
  });
  it('refuses when another click already queued it', async () => {
    const sb = fakeSupabase(readyRow(), { claim: false });
    await expect(queueExecute(sb, undefined, ID, 'person@example.com', actor)).rejects.toMatchObject({ code: 'IN_PROGRESS' });
  });
  it('claims with a compare-and-set and enqueues the job', async () => {
    const sb = fakeSupabase(readyRow());
    const jobs: unknown[] = [];
    await queueExecute(sb, async (...args) => { jobs.push(args); return { id: '1' }; }, ID, 'PERSON@example.com', actor);
    const claim = sb.calls.find((c) => c.op === 'update');
    expect(claim?.values).toMatchObject({ execute_status: 'queued' });
    expect(claim?.filters).toContainEqual(['in', 'execute_status', ['none', 'failed']]);
    expect(jobs).toHaveLength(1);
  });
  it('still queues when the host has no job queue (the sweep picks it up)', async () => {
    const sb = fakeSupabase(readyRow());
    await expect(queueExecute(sb, undefined, ID, 'person@example.com', actor)).resolves.toBeTruthy();
  });
});

describe('queuePreview', () => {
  it('only previews deletion requests', async () => {
    const sb = fakeSupabase(readyRow({ request_type: 'data_export' }));
    await expect(queuePreview(sb, undefined, ID, actor)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
  it('rejects a non-uuid id', async () => {
    const sb = fakeSupabase(readyRow());
    await expect(queuePreview(sb, undefined, 'not-a-uuid', actor)).rejects.toMatchObject({ status: 400 });
  });
});

describe('publicView', () => {
  it('reduces discovered identifiers to counts and never includes rows', () => {
    const view = publicView(readyRow({
      identifiers: { emails: ['person@example.com', 'alias@example.com'], person_ids: ['p1'], auth_user_ids: [] },
      plan: { summary: { rows: 4 }, tables: [{ table: 'people', entry: 'default', action: 'delete', rows: 1, note: 'x' }], blockers: [], warnings: [] },
    }));
    expect(view.preview.identifiers).toEqual({ emails: 2, people: 1, auth_users: 0 });
    expect(JSON.stringify(view)).not.toContain('alias@example.com');
    expect(view.preview.tables).toEqual([{ table: 'people', action: 'delete', rows: 1, retain: null }]);
  });
  it('hides the addresses once redacted', () => {
    expect(publicView(readyRow({ redacted_at: new Date().toISOString() })).emails).toBeNull();
  });
});

describe('reportMarkdown', () => {
  it('lists what was kept and the legal basis', () => {
    const md = reportMarkdown(readyRow({
      report: { database: [
        { table: 'people', entry: 'default', action: 'delete', rows: 1 },
        { table: 'payments_stripe_customers', entry: 'default', action: 'anonymise', rows: 1, retain: { reason: 'Payment records', basis: 'Art. 17(3)(b)', period: '7 years' } },
      ] },
    }));
    expect(md).toContain('| people | deleted | 1 |');
    expect(md).toContain('payments_stripe_customers: Payment records. Basis: Art. 17(3)(b). Period: 7 years');
    expect(md).toContain('one-way hash');
  });
});

describe('emailSha256', () => {
  it('matches the SQL normalisation (lowercase, trimmed)', () => {
    expect(emailSha256('  Person@Example.com ')).toBe(emailSha256('person@example.com'));
    expect(emailSha256('person@example.com')).toMatch(/^[0-9a-f]{64}$/);
  });
});
