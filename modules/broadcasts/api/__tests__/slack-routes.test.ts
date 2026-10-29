import { describe, it, expect } from 'vitest';
import { createSlackStatusHandler, createSlackTestHandler, parseSender } from '../slack-routes';

function res() {
  const out: { status: number; body: any } = { status: 200, body: null };
  const r: any = {
    status: (n: number) => { out.status = n; return r; },
    json: (b: unknown) => { out.body = b; return r; },
  };
  return { r, out };
}

function people(rows: Array<Record<string, unknown>>, error: unknown = null) {
  const seen: string[] = [];
  const supabase = {
    from: () => ({
      select: () => ({
        ilike: (_c: string, v: string) => { seen.push(v); return { limit: () => Promise.resolve({ data: error ? null : rows, error }) }; },
      }),
    }),
  };
  return { supabase, seen };
}

function slackFetch(log: string[]) {
  return async (url: string, init: RequestInit) => {
    const method = url.split('/').pop()!;
    log.push(`${method} ${new URLSearchParams(String(init.body)).toString()}`);
    if (method === 'conversations.open') return new Response(JSON.stringify({ ok: true, channel: { id: 'D1' } }));
    return new Response(JSON.stringify({ ok: true, ts: '1.2' }));
  };
}

const linked = { id: 'p1', email: 'sam@x.io', attributes: { slack_user_id: 'U0SAM1', first_name: '<!here>' } };

describe('POST /slack/test', () => {
  it('DMs the person, with their merge fields escaped', async () => {
    const { supabase, seen } = people([linked]);
    const log: string[] = [];
    const h = createSlackTestHandler({ supabase, fetchImpl: slackFetch(log) as never, readToken: async () => 'xoxb' });
    const { r, out } = res();
    await h({ body: { email: ' Sam@X.io ', text: 'Hi {{first_name}}', sender: 'bot' } } as never, r);
    expect(out).toEqual({ status: 200, body: { success: true } });
    expect(seen).toEqual(['sam@x.io']);
    expect(log[0]).toBe('conversations.open users=U0SAM1');
    expect(decodeURIComponent(log[1].replace(/\+/g, ' '))).toContain('text=Hi &lt;!here&gt;');
  });

  it('escapes LIKE wildcards in the address', async () => {
    const { supabase, seen } = people([]);
    const h = createSlackTestHandler({ supabase, readToken: async () => 'x' });
    const { r, out } = res();
    await h({ body: { email: 'a_b%c@x.io', text: 'hi' } } as never, r);
    expect(seen).toEqual(['a\\_b\\%c@x.io']);
    expect(out.status).toBe(404);
  });

  it.each([
    [{ email: 'nope', text: 'hi' }, 'valid email'],
    [{ email: 'a*@x.io', text: 'hi' }, 'valid email'],
    [{ email: 'a@x.io', text: '  ' }, 'empty'],
    [{ email: 'a@x.io', text: 'x'.repeat(4001) }, '4000'],
    [{ email: 'a@x.io', text: 'hi', sender: 'root' }, 'Unknown sender'],
  ])('rejects %o', async (body, msg) => {
    const { supabase } = people([linked]);
    const h = createSlackTestHandler({ supabase, readToken: async () => 'x' });
    const { r, out } = res();
    await h({ body } as never, r);
    expect(out.status).toBe(400);
    expect(out.body.error).toContain(msg);
  });

  it('says when the person is not linked to Slack', async () => {
    const { supabase } = people([{ id: 'p', email: 'a@x.io', attributes: {} }]);
    const h = createSlackTestHandler({ supabase, readToken: async () => 'x' });
    const { r, out } = res();
    await h({ body: { email: 'a@x.io', text: 'hi' } } as never, r);
    expect(out).toMatchObject({ status: 404, body: { error: 'That person is not linked to a Slack member' } });
  });

  it('reports a missing token without calling Slack', async () => {
    const { supabase } = people([linked]);
    const log: string[] = [];
    const h = createSlackTestHandler({ supabase, fetchImpl: slackFetch(log) as never, readToken: async () => '' });
    const { r, out } = res();
    await h({ body: { email: 'sam@x.io', text: 'hi' } } as never, r);
    expect(out.status).toBe(502);
    expect(out.body.error).toMatch(/No Slack token/);
    expect(log).toHaveLength(0);
  });
});

describe('GET /slack/status', () => {
  it('reports missing bot scopes and the welcome sender, never a token', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ ok: true, team: 'AAIF', user: 'aaif-bot' }), { headers: { 'x-oauth-scopes': 'chat:write,users:read' } });
    const h = createSlackStatusHandler({
      supabase: {}, fetchImpl: fetchImpl as never, readToken: async () => 'xoxb-secret',
      readSender: async () => ({ slack_user_name: 'demetrios', status: 'active' }),
    });
    const { r, out } = res();
    await h({} as never, r);
    expect(out.body).toEqual({
      bot: { configured: true, ok: true, error: undefined, team: 'AAIF', name: 'aaif-bot', missing_scopes: ['im:write'] },
      welcome_sender: { connected: true, name: 'demetrios', status: 'active' },
    });
    expect(JSON.stringify(out.body)).not.toContain('xoxb-secret');
  });

  it('reports an unconfigured bot', async () => {
    const h = createSlackStatusHandler({ supabase: {}, readToken: async () => '', readSender: async () => null });
    const { r, out } = res();
    await h({} as never, r);
    expect(out.body).toEqual({ bot: { configured: false }, welcome_sender: { connected: false } });
  });
});

it('parseSender allows only the two senders', () => {
  expect(parseSender('bot')).toBe('bot');
  expect(parseSender('welcome_sender')).toBe('welcome_sender');
  expect(parseSender('x')).toBeNull();
});
