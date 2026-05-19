/**
 * Admin API client for the tasks module.
 *
 * Authenticates by pulling the current Supabase session and sending
 * `Authorization: Bearer ${access_token}` — matches the convention
 * used by other admin modules (e.g. people, onboarding). The API
 * base URL comes from `VITE_API_URL`.
 */

import { supabase } from '@/lib/supabase';
import type {
  BoardSummary,
  Status,
  CustomFieldDef,
  Task,
  TreeTask,
  Comment,
  ActivityFeedItem,
  Notification,
  Person,
  EntityType,
  Uuid,
} from '../../lib/types';

const API_BASE =
  (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env
    ?.VITE_API_URL ?? '';
const PATH_PREFIX = `${API_BASE}/api/admin/tasks`;

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const auth = await authHeader();
  const res = await fetch(`${PATH_PREFIX}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...auth,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let err: unknown;
    try { err = await res.json(); } catch { /* empty body */ }
    throw new ApiError(res.status, err);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(typeof body === 'object' && body && 'error' in body
      ? String((body as { error?: { message?: string } }).error?.message ?? `HTTP ${status}`)
      : `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

// People (admin profiles)
export const listPeople = () => jsonFetch<{ data: Person[] }>(`/people`);

// Boards
export const listBoards = () => jsonFetch<{ data: BoardSummary[] }>(`/boards`);
export const createBoard = (body: Partial<BoardSummary>) =>
  jsonFetch<{ data: { board: BoardSummary; statuses: Status[] } }>(`/boards`, {
    method: 'POST', body: JSON.stringify(body),
  });
export const getBoard = (id: Uuid) =>
  jsonFetch<{ data: { board: BoardSummary; statuses: Status[]; custom_fields: CustomFieldDef[]; members: unknown[] } }>(
    `/boards/${id}`,
  );
export const patchBoard = (id: Uuid, body: Partial<BoardSummary>) =>
  jsonFetch<{ data: BoardSummary }>(`/boards/${id}`, {
    method: 'PATCH', body: JSON.stringify(body),
  });

// Statuses
export const createStatus = (boardId: Uuid, body: Partial<Status>) =>
  jsonFetch<{ data: Status }>(`/boards/${boardId}/statuses`, {
    method: 'POST', body: JSON.stringify(body),
  });
export const patchStatus = (boardId: Uuid, sid: Uuid, body: Partial<Status>) =>
  jsonFetch<{ data: Status }>(`/boards/${boardId}/statuses/${sid}`, {
    method: 'PATCH', body: JSON.stringify(body),
  });
export const deleteStatus = (boardId: Uuid, sid: Uuid) =>
  jsonFetch<{ data: { deleted: boolean } }>(`/boards/${boardId}/statuses/${sid}`, { method: 'DELETE' });

// Tasks
export const listTasks = (boardId: Uuid, params: Record<string, string | boolean | undefined> = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const qs = q.toString();
  return jsonFetch<{ data: {
    tasks?: TreeTask[] | Task[];
    statuses?: Status[];
    custom_fields?: CustomFieldDef[];
    columns?: Array<{ status: Status; tasks: Task[] }>;
    is_truncated?: boolean;
  } }>(`/boards/${boardId}/tasks${qs ? '?' + qs : ''}`);
};
export const createTask = (boardId: Uuid, body: Record<string, unknown>) =>
  jsonFetch<{ data: { task: Task } }>(`/boards/${boardId}/tasks`, {
    method: 'POST', body: JSON.stringify(body),
  });
export const getTask = (id: Uuid) =>
  jsonFetch<{ data: { task: Task; custom_field_values: unknown[]; links: unknown[]; dependencies: unknown[] } }>(`/tasks/${id}`);
export const patchTask = (id: Uuid, body: Record<string, unknown>) =>
  jsonFetch<{ data: { task: Task } }>(`/tasks/${id}`, {
    method: 'PATCH', body: JSON.stringify(body),
  });
export const deleteTask = (id: Uuid) =>
  jsonFetch<{ data: { deleted: boolean } }>(`/tasks/${id}`, { method: 'DELETE' });
export const reorderTask = (id: Uuid, body: { after_task_id?: string | null; before_task_id?: string | null }) =>
  jsonFetch<{ data: { task: { id: Uuid; sort_index: string } } }>(`/tasks/${id}/reorder`, {
    method: 'POST', body: JSON.stringify(body),
  });
export const reparentTask = (id: Uuid, body: { new_parent_id: string | null; after_task_id?: string | null; before_task_id?: string | null }) =>
  jsonFetch<{ data: { task: { id: Uuid; parent_task_id: string | null; sort_index: string } } }>(`/tasks/${id}/reparent`, {
    method: 'POST', body: JSON.stringify(body),
  });

// Dependencies
export const addDependency = (taskId: Uuid, blockerId: Uuid) =>
  jsonFetch<{ data: { added: boolean } }>(`/tasks/${taskId}/dependencies`, {
    method: 'POST', body: JSON.stringify({ blocker_id: blockerId }),
  });
export const removeDependency = (taskId: Uuid, blockerId: Uuid) =>
  jsonFetch<{ data: { removed: boolean } }>(`/tasks/${taskId}/dependencies/${blockerId}`, { method: 'DELETE' });

// Links
export const addLink = (taskId: Uuid, entityType: EntityType, entityId: Uuid) =>
  jsonFetch<{ data: { link: unknown } }>(`/tasks/${taskId}/links`, {
    method: 'POST', body: JSON.stringify({ entity_type: entityType, entity_id: entityId }),
  });
export const tasksByEntity = (entityType: EntityType, entityId: Uuid) =>
  jsonFetch<{ data: { tasks: Task[] } }>(`/by-entity/${entityType}/${entityId}`);

// Comments + activity
export const listComments = (taskId: Uuid) =>
  jsonFetch<{ data: Comment[] }>(`/tasks/${taskId}/comments`);
export const postComment = (taskId: Uuid, body: string) =>
  jsonFetch<{ data: Comment }>(`/tasks/${taskId}/comments`, {
    method: 'POST', body: JSON.stringify({ body }),
  });
export const listActivity = (taskId: Uuid) =>
  jsonFetch<{ data: { items: ActivityFeedItem[] } }>(`/tasks/${taskId}/activity`);

// Notifications
export const listNotifications = (unreadOnly = false) =>
  jsonFetch<{ data: { items: Notification[] } }>(`/notifications${unreadOnly ? '?unread_only=true' : ''}`);
export const unreadCount = () =>
  jsonFetch<{ data: { count: number } }>(`/notifications/unread-count`);
export const markRead = (ids: string[] | { all: true }) =>
  jsonFetch<{ data: { marked: boolean } }>(`/notifications/mark-read`, {
    method: 'POST', body: JSON.stringify(Array.isArray(ids) ? { ids } : ids),
  });
