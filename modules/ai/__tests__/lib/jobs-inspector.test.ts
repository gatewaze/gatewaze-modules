/**
 * Tests for lib/jobs/inspector.ts — DTO derivation logic without a
 * real BullMQ. The Redis/Queue surface is exercised by integration
 * tests; here we validate the pure transformations (owner_module,
 * linked_row, status mapping).
 */

import { describe, expect, it, vi } from 'vitest';

// Mock the redis-client import so jobToDto doesn't try a real
// XINFO STREAM call. Stream offset comes back null.
vi.mock('../../lib/jobs/redis-client.js', () => ({
  getRedisClient: async () => ({
    xinfo: async () => {
      throw new Error('mock — no real redis');
    },
  }),
}));

const { jobToDto } = await import('../../lib/jobs/inspector.js');

function makeJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? 'job-1',
    name: overrides.name ?? 'ai:run-recipe',
    data: overrides.data ?? { runId: '00000000-0000-0000-0000-000000000001' },
    timestamp: overrides.timestamp ?? 1762000000000,
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: overrides.opts ?? { attempts: 2 },
    processedOn: overrides.processedOn ?? null,
    finishedOn: overrides.finishedOn ?? null,
    failedReason: overrides.failedReason ?? null,
    stacktrace: overrides.stacktrace ?? null,
    ...overrides,
  };
}

describe('jobToDto', () => {
  it('derives owner_module=ai from ai:* prefix', async () => {
    const dto = await jobToDto(makeJob({ name: 'ai:run-recipe' }), 'active');
    expect(dto.owner_module).toBe('ai');
    expect(dto.linked_row).toEqual({
      table: 'ai_recipe_runs',
      id: '00000000-0000-0000-0000-000000000001',
    });
  });

  it('derives owner_module=ai for ai.sync-* dot-namespaced jobs', async () => {
    const dto = await jobToDto(makeJob({ name: 'ai.sync-skill-sources' }), 'waiting');
    expect(dto.owner_module).toBe('ai');
  });

  it('derives owner_module=scrapers from scraper:* prefix', async () => {
    const dto = await jobToDto(
      makeJob({
        name: 'scraper:run',
        data: { scraperJobId: 42 },
      }),
      'active',
    );
    expect(dto.owner_module).toBe('scrapers');
    expect(dto.linked_row).toEqual({ table: 'scrapers_jobs', id: '42' });
  });

  it('derives linked_row for chat jobs from assistantMessageId', async () => {
    const dto = await jobToDto(
      makeJob({
        name: 'ai:run-chat',
        data: {
          threadId: '00000000-0000-0000-0000-000000000002',
          assistantMessageId: '00000000-0000-0000-0000-000000000003',
        },
      }),
      'active',
    );
    expect(dto.linked_row).toEqual({
      table: 'ai_messages',
      id: '00000000-0000-0000-0000-000000000003',
    });
  });

  it('returns null linked_row when data lacks the backref', async () => {
    const dto = await jobToDto(makeJob({ name: 'ai:run-recipe', data: {} }), 'active');
    expect(dto.linked_row).toBeNull();
  });

  it('computes attempts_remaining from opts.attempts - attemptsMade', async () => {
    const dto = await jobToDto(
      makeJob({ attemptsMade: 1, opts: { attempts: 3 } }),
      'failed',
    );
    expect(dto.attempts_made).toBe(1);
    expect(dto.attempts_remaining).toBe(2);
  });

  it('clamps attempts_remaining at 0', async () => {
    const dto = await jobToDto(
      makeJob({ attemptsMade: 5, opts: { attempts: 1 } }),
      'failed',
    );
    expect(dto.attempts_remaining).toBe(0);
  });

  it('truncates stacktrace to 3 frames', async () => {
    const dto = await jobToDto(
      makeJob({
        stacktrace: ['frame1', 'frame2', 'frame3', 'frame4', 'frame5'],
      }),
      'failed',
    );
    expect(dto.stacktrace).toEqual(['frame1', 'frame2', 'frame3']);
  });

  it('derives stream_key for ai:run-recipe', async () => {
    const dto = await jobToDto(
      makeJob({ name: 'ai:run-recipe', data: { runId: 'abc' } }),
      'active',
    );
    expect(dto.stream_key).toMatch(/:ai:run:abc$/);
  });

  it('derives stream_key for ai:run-chat from threadId', async () => {
    const dto = await jobToDto(
      makeJob({
        name: 'ai:run-chat',
        data: { threadId: 'thread-uuid', assistantMessageId: 'msg-uuid' },
      }),
      'active',
    );
    expect(dto.stream_key).toMatch(/:ai:thread:thread-uuid$/);
  });

  it('no stream_key for non-streaming jobs', async () => {
    const dto = await jobToDto(makeJob({ name: 'ai.sync-skill-sources', data: {} }), 'waiting');
    expect(dto.stream_key).toBeNull();
  });

  it('marks owner_module=unknown for unrecognised names', async () => {
    const dto = await jobToDto(makeJob({ name: 'totally-foreign' }), 'active');
    expect(dto.owner_module).toBe('unknown');
  });
});
