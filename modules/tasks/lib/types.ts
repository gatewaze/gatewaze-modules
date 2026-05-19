/**
 * Shared types for the tasks module (spec §6.13).
 */

export type Uuid = string;

export type DependencyMode = 'hard' | 'soft';
export type ParentCompletion = 'auto' | 'manual';
export type KanbanIncludes = 'top_only' | 'all';
export type FieldType = 'text' | 'number' | 'select' | 'multi_select' | 'date' | 'person' | 'url' | 'boolean';
export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
export type Role = 'owner' | 'editor' | 'viewer';
export type WebhookKind = 'slack' | 'discord' | 'generic';
export type EntityType = 'events' | 'speakers' | 'content_items' | 'lists' | 'pipelines' | 'forms';
export type NotificationKind = 'assigned' | 'mentioned' | 'comment_on_followed' | 'due_soon' | 'status_changed_for_followed';

export interface Person {
  id: Uuid;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

export interface BoardSummary {
  id: Uuid;
  name: string;
  slug: string;
  description: string | null;
  dependency_mode: DependencyMode;
  parent_completion: ParentCompletion;
  kanban_includes: KanbanIncludes;
  realtime_enabled: boolean;
  time_zone: string | null;
  color: string | null;
  icon: string | null;
  archived: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Status {
  id: Uuid;
  board_id: Uuid;
  name: string;
  color: string | null;
  sort_index: number;
  is_done_state: boolean;
  is_default: boolean;
}

export interface CustomFieldDef {
  id: Uuid;
  board_id: Uuid;
  key: string;
  label: string;
  field_type: FieldType;
  options: Array<{ label: string; value: string; color?: string }> | null;
  required: boolean;
  sort_index: number;
  archived: boolean;
}

export type CustomFieldValueShape = string | number | boolean | string[] | null;

export interface CustomFieldValue {
  field_id: Uuid;
  value: CustomFieldValueShape;
}

export interface Task {
  id: Uuid;
  board_id: Uuid;
  parent_task_id: Uuid | null;
  title: string;
  description: string | null;
  status_id: Uuid | null;
  assignee_id: Uuid | null;
  priority: Priority | null;
  estimate_hours: number | null;
  start_date: string | null;
  due_date: string | null;
  sort_index: string;
  is_done: boolean;
  completed_at: string | null;
  recurrence_rule: string | null;
  recurrence_parent_id: Uuid | null;
  deleted_at: string | null;
  created_by: Uuid | null;
  created_at: string;
  updated_at: string;
  custom_field_values?: CustomFieldValue[];
  is_blocked?: boolean;
  open_blockers?: Uuid[];
}

export interface TreeTask extends Task {
  depth: number;
  path: string[];
}

export interface TaskLink {
  id: Uuid;
  task_id: Uuid;
  entity_type: EntityType;
  entity_id: Uuid;
  created_at: string;
}

export interface Comment {
  id: Uuid;
  task_id: Uuid;
  author_id: Uuid;
  body: string;
  mentions: Uuid[];
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ActivityRow {
  id: Uuid;
  task_id: Uuid;
  actor_id: Uuid | null;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: string;
}

export type ActivityFeedItem =
  | { kind: 'comment'; occurred_at: string; comment: Comment }
  | { kind: 'activity'; occurred_at: string; activity: ActivityRow };

export interface Notification {
  id: Uuid;
  recipient_id: Uuid;
  task_id: Uuid;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  read_at: string | null;
  emailed_at: string | null;
  created_at: string;
}

export interface SuccessEnvelope<T> {
  data: T;
  meta: { request_id: string; pagination?: { cursor: string | null; limit: number } };
}

export interface ErrorEnvelope {
  error: { code: string; message: string; details?: Record<string, unknown> };
  meta: { request_id: string };
}
