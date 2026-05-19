import { describe, it, expect } from 'vitest';
import { buildPayload } from '../lib/webhook-payload';

const board = {
  id: 'b1',
  name: 'Marketing',
  slug: 'marketing',
  description: null,
  dependency_mode: 'soft' as const,
  parent_completion: 'manual' as const,
  kanban_includes: 'top_only' as const,
  realtime_enabled: true,
  time_zone: null,
  color: null,
  icon: null,
  archived: false,
  archived_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const task = {
  id: 't1',
  board_id: 'b1',
  parent_task_id: null,
  title: 'Confirm speakers',
  description: 'Reach out to the 8 candidates',
  status_id: 's1',
  assignee_id: null,
  priority: 'high' as const,
  estimate_hours: null,
  start_date: null,
  due_date: '2026-05-20',
  sort_index: 'M',
  is_done: false,
  completed_at: null,
  recurrence_rule: null,
  recurrence_parent_id: null,
  deleted_at: null,
  created_by: null,
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
};

describe('buildPayload', () => {
  it('produces slack blocks shape', () => {
    const r = buildPayload('task.created', task, board, 'slack', { includeDescription: true });
    const parsed = JSON.parse(r.body);
    expect(parsed.blocks).toBeDefined();
    expect(parsed.blocks[0].type).toBe('header');
  });

  it('produces discord embed shape', () => {
    const r = buildPayload('task.completed', task, board, 'discord', { includeDescription: true });
    const parsed = JSON.parse(r.body);
    expect(parsed.embeds).toBeDefined();
    expect(parsed.embeds[0].title).toContain('Task completed');
  });

  it('redacts description when include_description=false', () => {
    const r = buildPayload('task.created', task, board, 'generic', { includeDescription: false });
    const parsed = JSON.parse(r.body);
    expect(parsed.task.description).toBeUndefined();
    expect(parsed.task.title).toBe(task.title);
  });

  it('signs generic payload when secret provided', () => {
    const r = buildPayload('task.created', task, board, 'generic', { includeDescription: true }, 's3cret');
    expect(r.signatureHeader?.name).toBe('X-Tasks-Signature');
    expect(r.signatureHeader?.value).toMatch(/t=\d+, v1=[0-9a-f]{64}/);
  });
});
