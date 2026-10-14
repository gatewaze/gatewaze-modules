import { describe, it, expect } from 'vitest';
import { customerio, sendgrid, segment, buildChecklist, isComplete, type Identifiers } from '../lib/processors';

const ids: Identifiers = {
  emails: ['person@example.com'],
  person_ids: ['p1'],
  auth_user_ids: ['u1'],
  cio_ids: ['abc'],
  slack_user_ids: ['U123'],
};

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 200 };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('customerio', () => {
  it('is skipped when not configured', async () => {
    expect((await customerio(ids, {})).status).toBe('skipped');
  });
  it('suppresses the cio id and every email', async () => {
    const { f, calls } = fakeFetch([{ status: 200 }, { status: 404 }]);
    const r = await customerio(ids, { CUSTOMERIO_SITE_ID: 's', CUSTOMERIO_API_KEY: 'k' }, f);
    expect(r.status).toBe('erased');
    expect(calls.map((c) => c.url)).toEqual([
      'https://track.customer.io/api/v1/customers/cio_abc/suppress',
      'https://track.customer.io/api/v1/customers/person%40example.com/suppress',
    ]);
  });
  it('uses the EU host when configured', async () => {
    const { f, calls } = fakeFetch([{ status: 200 }, { status: 200 }]);
    await customerio(ids, { CUSTOMERIO_SITE_ID: 's', CUSTOMERIO_API_KEY: 'k', CUSTOMERIO_REGION: 'eu' }, f);
    expect(calls[0].url.startsWith('https://track-eu.customer.io/')).toBe(true);
  });
  it('reports a failure without throwing', async () => {
    const { f } = fakeFetch([{ status: 500 }, { status: 200 }]);
    const r = await customerio(ids, { CUSTOMERIO_SITE_ID: 's', CUSTOMERIO_API_KEY: 'k' }, f);
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('1 of 2');
  });
});

describe('sendgrid', () => {
  const env = { SENDGRID_API_KEY: 'sg' };
  it('unsubscribes globally and deletes marketing contacts', async () => {
    const { f, calls } = fakeFetch([
      { status: 201 },
      { status: 200, body: { result: { 'person@example.com': { contact: { id: 'c1' } } } } },
      { status: 202 },
    ]);
    const r = await sendgrid(ids, env, f);
    expect(r.status).toBe('erased');
    expect(calls[0].url).toBe('https://api.sendgrid.com/v3/asm/suppressions/global');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ recipient_emails: ['person@example.com'] });
    expect(calls[2].url).toBe('https://api.sendgrid.com/v3/marketing/contacts?ids=c1');
    expect(calls[2].init.method).toBe('DELETE');
  });
  it('treats no contacts as done', async () => {
    const { f } = fakeFetch([{ status: 201 }, { status: 404 }]);
    expect((await sendgrid(ids, env, f)).status).toBe('erased');
  });
  it('becomes a manual step when the key cannot read contacts', async () => {
    const { f } = fakeFetch([{ status: 201 }, { status: 403 }]);
    expect((await sendgrid(ids, env, f)).status).toBe('manual');
  });
  it('fails if the global unsubscribe fails', async () => {
    const { f } = fakeFetch([{ status: 401 }]);
    expect((await sendgrid(ids, env, f)).status).toBe('failed');
  });
});

describe('segment', () => {
  it('only appears when Segment is in use, as a manual step with the userId', () => {
    expect(segment(ids, {})).toBeNull();
    const r = segment(ids, { SEGMENT_WRITE_KEY: 'w' });
    expect(r?.status).toBe('manual');
    expect(r?.detail).toContain('u1');
  });
});

describe('checklist', () => {
  it('adds steps for what the plan found', () => {
    const items = buildChecklist(
      { tables: [{ table: 'integrations_luma_event_registrations', rows: 1 }, { table: 'payments_stripe_customers', rows: 1 }] },
      ids,
      [{ id: 'segment', name: 'Segment', status: 'manual', detail: 'x', at: '' }],
    );
    expect(items.map((i) => i.id)).toEqual(['luma', 'slack', 'stripe', 'processor:segment']);
  });
  it('is complete only when no processor failed and every step is ticked', () => {
    const ok = [{ id: 'sendgrid', name: 'SendGrid', status: 'erased' as const, at: '' }];
    expect(isComplete(ok, [])).toBe(true);
    expect(isComplete(ok, [{ id: 'luma', title: 'x', done: false }])).toBe(false);
    expect(isComplete([{ id: 'c', name: 'C', status: 'failed', at: '' }], [])).toBe(false);
  });
});
