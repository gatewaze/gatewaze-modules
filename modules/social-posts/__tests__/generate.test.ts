import { describe, expect, it } from 'vitest';
import { classifyRunChatError, generatePost, GenerateError, type RunChat } from '../lib/generate';
import { parseDraftCreate, parseDraftPatch } from '../lib/drafts';
import { createRateLimiter } from '../lib/rate-limit';
import type { PoolItem } from '../lib/pool-types';

const ID1 = '11111111-1111-4111-8111-111111111111';

const item: PoolItem = {
  contentType: 'blog_post',
  contentId: ID1,
  typeLabel: 'Blog post',
  title: 'Introducing the MCPA',
  url: 'https://aaif.io/blog/mcpa/',
  date: '2026-07-10',
  location: null,
  summary: null,
  body: 'Body',
  thumbnailUrl: null,
  members: ['Cisco'],
};

function scripted(answers: Array<Record<string, unknown> | null | Error>) {
  const prompts: string[] = [];
  const useCases: string[] = [];
  const runChat: RunChat = async (_ctx, opts) => {
    prompts.push(opts.messages[0].content);
    useCases.push(opts.useCase);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { structured: next ?? null, model: 'claude-sonnet-5', costMicroUsd: 1000 };
  };
  return { runChat, prompts, useCases };
}

const input = { platform: 'linkedin' as const, format: 'announcement' as const, items: [item], instructions: null, userId: 'u1' };

describe('generatePost', () => {
  it('runs under the LinkedIn use case and returns the finished post', async () => {
    const s = scripted([{ text: 'Hook.\n\nWith @Cisco.\n\nhttps://aaif.io/blog/mcpa/', hashtags: ['MCP', 'AI', 'Certification'], mentions: ['Cisco'] }]);
    const r = await generatePost(s.runChat, {}, input);
    expect(s.useCases).toEqual(['social-posts-linkedin']);
    expect(r.text.endsWith('#MCP #AI #Certification')).toBe(true);
    expect(r.mentions).toEqual(['Cisco']);
    expect(r).toMatchObject({ model: 'claude-sonnet-5', costMicroUsd: 1000 });
  });
  it('retries once with a correction when the answer is empty', async () => {
    const s = scripted([null, { text: 'Hook. https://aaif.io/blog/mcpa/', hashtags: ['A', 'B', 'C'], mentions: [] }]);
    const r = await generatePost(s.runChat, {}, input);
    expect(s.prompts).toHaveLength(2);
    expect(s.prompts[1]).toMatch(/previous answer was not usable/);
    expect(r.costMicroUsd).toBe(2000);
  });
  it('fails after two empty answers', async () => {
    const s = scripted([null, null]);
    await expect(generatePost(s.runChat, {}, input)).rejects.toMatchObject({ code: 'ai_bad_output', status: 502 });
  });
  it('retries an over-long post, then trims the second one', async () => {
    const long = { text: ('Paragraph text here. '.repeat(40) + '\n\n').repeat(6), hashtags: ['A', 'B', 'C'], mentions: [] };
    const s = scripted([long, long]);
    const r = await generatePost(s.runChat, {}, { ...input, items: [{ ...item, url: null }] });
    expect(s.prompts[1]).toMatch(/LinkedIn allows 3000/);
    expect(r.text.length).toBeLessThanOrEqual(3000);
    expect(r.warnings.join(' ')).toMatch(/was cut/);
  });
  it('maps a budget error from runChat to a 429', async () => {
    const s = scripted([new Error("budget_exceeded: today's spend for 'social-posts-linkedin' would breach cap")]);
    await expect(generatePost(s.runChat, {}, input)).rejects.toMatchObject({ status: 429, code: 'budget_exceeded' });
  });
});

describe('classifyRunChatError', () => {
  it('hides provider detail behind a safe message', () => {
    const e = classifyRunChatError(new Error('anthropic 500: internal secret detail'));
    expect(e).toBeInstanceOf(GenerateError);
    expect(e.status).toBe(502);
    expect(e.message).not.toMatch(/secret/);
  });
  it('maps missing credentials and timeouts', () => {
    expect(classifyRunChatError(Object.assign(new Error('x'), { name: 'NoCredentialsError' })).status).toBe(503);
    expect(classifyRunChatError(Object.assign(new Error('x'), { name: 'ProviderTimeoutError' })).status).toBe(504);
    expect(classifyRunChatError(Object.assign(new Error('rate'), { httpStatus: 429 })).code).toBe('rate_limited');
    expect(classifyRunChatError(new Error("use_case 'social-posts-linkedin' not registered")).status).toBe(503);
    expect(classifyRunChatError(Object.assign(new Error('x'), { name: 'ProviderRateLimitError' })).code).toBe('rate_limited');
    expect(classifyRunChatError(new Error("daily_call_cap check failed for 'x'")).code).toBe('budget_exceeded');
  });
  it('keeps the provider error as the cause for the log', () => {
    const original = new Error('anthropic 500');
    expect(classifyRunChatError(original).cause).toBe(original);
  });
});

describe('drafts', () => {
  const base = { format: 'announcement', body: 'Hello', sources: [{ content_type: 'blog_post', content_id: ID1 }] };
  it('accepts a minimal draft with defaults', () => {
    const r = parseDraftCreate(base);
    expect(r.ok && r.value).toMatchObject({ platform: 'linkedin', status: 'draft', hashtags: [], generated: false });
  });
  it('rejects bad enums, a long body, and editor-only statuses', () => {
    expect(parseDraftCreate({ ...base, format: 'thread' }).ok).toBe(false);
    expect(parseDraftCreate({ ...base, platform: 'x' }).ok).toBe(false);
    expect(parseDraftCreate({ ...base, status: 'posted' }).ok).toBe(false);
    expect(parseDraftCreate({ ...base, body: 'x'.repeat(3001) }).ok).toBe(false);
    expect(parseDraftCreate({ ...base, sources: [] }).ok).toBe(false);
    expect(parseDraftCreate({ ...base, instructions: 'x'.repeat(1001) }).ok).toBe(false);
  });
  it('drops an ai_model that is not a model id', () => {
    const r = parseDraftCreate({ ...base, ai_model: '<script>' });
    expect(r.ok && r.value.ai_model).toBeNull();
  });
  it('patches only the fields sent, and refuses an empty patch', () => {
    const r = parseDraftPatch({ status: 'ready', created_by: 'someone' }, 'linkedin');
    expect(r.ok && r.value).toEqual({ status: 'ready' });
    expect(parseDraftPatch({}, 'linkedin').ok).toBe(false);
    expect(parseDraftPatch({ status: 'scheduled' }, 'linkedin').ok).toBe(false);
    expect(parseDraftPatch({ format: 'thread' }, 'linkedin').ok).toBe(false);
    expect(parseDraftPatch({ body: 'x'.repeat(3001) }, 'linkedin').ok).toBe(false);
    expect(parseDraftPatch({ body: '  ' }, 'linkedin').ok).toBe(false);
    const regen = parseDraftPatch({ body: 'new', regenerated: true, ai_model: 'claude-sonnet-5', instructions: ' Shorter ' }, 'linkedin');
    expect(regen.ok && regen.value).toEqual({ body: 'new', regenerated: true, ai_model: 'claude-sonnet-5', instructions: 'Shorter' });
    expect(parseDraftPatch({ format: 'roundup', hashtags: ['#A b', 'a b'] }, 'linkedin')).toEqual({ ok: true, value: { format: 'roundup', hashtags: ['Ab'] } });
    expect(parseDraftPatch({ regenerated: true, instructions: 'x'.repeat(1001) }, 'linkedin').ok).toBe(false);
    const plain = parseDraftPatch({ body: 'new', ai_model: 'claude-sonnet-5' }, 'linkedin');
    expect(plain.ok && plain.value).toEqual({ body: 'new' });
  });
});

describe('rate limiter', () => {
  it('allows max per window per key, then gives a retry time', () => {
    const l = createRateLimiter({ max: 2, windowMs: 60_000 });
    // (The route uses max 10; routes.test.ts pins that number.)
    expect(l.take('a', 0).ok).toBe(true);
    expect(l.take('a', 1).ok).toBe(true);
    expect(l.take('b', 1).ok).toBe(true);
    const third = l.take('a', 30_000);
    expect(third).toEqual({ ok: false, retryAfterSec: 30 });
    expect(l.take('a', 60_000).ok).toBe(true);
  });
});

describe('rate limiter memory', () => {
  it('drops expired windows once it holds over 1000 keys', () => {
    const l = createRateLimiter({ max: 1, windowMs: 1000 });
    for (let i = 0; i <= 1000; i++) l.take(`k${i}`, 0);
    expect(l.take('k0', 0).ok).toBe(false);
    expect(l.take('new', 5000).ok).toBe(true);
    expect(l.take('k0', 5000).ok).toBe(true);
  });
});
