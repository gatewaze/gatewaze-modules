/**
 * Webhook payload shapers (spec §13.4).
 */

import { createHmac } from 'node:crypto';
import type { BoardSummary, Task, WebhookKind } from './types.js';

export interface BuildOpts {
  includeDescription: boolean;
}

export interface PayloadResult {
  body: string;          // JSON-stringified
  contentType: string;
  signatureHeader?: { name: string; value: string };
}

export function buildPayload(
  event: string,
  task: Task,
  board: BoardSummary,
  kind: WebhookKind,
  opts: BuildOpts,
  secret?: string | null,
): PayloadResult {
  const taskForPayload: Partial<Task> = {
    id: task.id,
    title: task.title,
    status_id: task.status_id,
    assignee_id: task.assignee_id,
    priority: task.priority,
    due_date: task.due_date,
    start_date: task.start_date,
    is_done: task.is_done,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
  if (opts.includeDescription) {
    taskForPayload.description = task.description;
  }

  let body: string;
  let contentType = 'application/json';

  switch (kind) {
    case 'slack':
      body = JSON.stringify(buildSlack(event, taskForPayload, board));
      break;
    case 'discord':
      body = JSON.stringify(buildDiscord(event, taskForPayload, board));
      break;
    case 'generic':
      body = JSON.stringify({
        event,
        occurred_at: new Date().toISOString(),
        task: taskForPayload,
        board: { id: board.id, name: board.name, slug: board.slug },
      });
      break;
  }

  const result: PayloadResult = { body, contentType };
  if (kind === 'generic' && secret) {
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    result.signatureHeader = {
      name: 'X-Tasks-Signature',
      value: `t=${t}, v1=${sig}`,
    };
  }
  return result;
}

function buildSlack(event: string, task: Partial<Task>, board: BoardSummary) {
  return {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: friendlyHeader(event, task) },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Board:* ${board.name}` },
          { type: 'mrkdwn', text: `*Title:* ${task.title ?? '(untitled)'}` },
          ...(task.due_date ? [{ type: 'mrkdwn', text: `*Due:* ${task.due_date}` }] : []),
          ...(task.priority ? [{ type: 'mrkdwn', text: `*Priority:* ${task.priority}` }] : []),
        ],
      },
    ],
  };
}

function buildDiscord(event: string, task: Partial<Task>, board: BoardSummary) {
  return {
    embeds: [
      {
        title: friendlyHeader(event, task),
        fields: [
          { name: 'Board', value: board.name, inline: true },
          { name: 'Title', value: task.title ?? '(untitled)', inline: true },
          ...(task.due_date ? [{ name: 'Due', value: task.due_date, inline: true }] : []),
          ...(task.priority ? [{ name: 'Priority', value: task.priority, inline: true }] : []),
        ],
      },
    ],
  };
}

function friendlyHeader(event: string, task: Partial<Task>): string {
  const t = task.title ?? '(untitled)';
  switch (event) {
    case 'task.created': return `New task: ${t}`;
    case 'task.completed': return `Task completed: ${t}`;
    case 'task.assigned': return `Task assigned: ${t}`;
    case 'task.deleted': return `Task deleted: ${t}`;
    case 'comment.posted': return `New comment on: ${t}`;
    default: return `${event}: ${t}`;
  }
}
