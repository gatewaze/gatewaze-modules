/**
 * GET /api/admin/modules/editor-ai-copilot/thread
 *
 * Returns the persisted copilot transcript for a canvas target as the
 * sidebar's bubble sequence, so the conversation rehydrates on reload.
 * Thread identity is the natural 4-tuple
 * (use_case='editor-ai-copilot', host_kind, host_id, thread_key=target_id) —
 * the same key generate.ts writes under, so no thread id crosses the wire.
 */

import type { Request, Response } from 'express';
import { rowsToTranscript, type AiMessageRow } from '../lib/transcript.js';
import type { HostKind } from '../lib/types.js';

interface RequestWithUser extends Request {
  userId?: string;
}

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

interface CreateThreadRouteDeps {
  supabase: SupabaseLike;
  logger: {
    warn: (msg: string, fields?: Record<string, unknown>) => void;
  };
  assertCanAdminHost: (
    hostKind: HostKind,
    hostId: string,
    userId: string,
  ) => Promise<{ ok: true } | { ok: false; httpStatus: number; code: string; message: string }>;
}

const COPILOT_USE_CASE = 'editor-ai-copilot';

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function createThreadLoadRoute(deps: CreateThreadRouteDeps) {
  return async function threadLoadHandler(req: RequestWithUser, res: Response): Promise<void> {
    const userId = req.userId;
    if (!userId) {
      sendError(res, 401, 'unauthenticated', 'session required');
      return;
    }

    const hostKind = (req.query.host_kind as string | undefined) as HostKind | undefined;
    const hostId = req.query.host_id as string | undefined;
    const targetId = req.query.target_id as string | undefined;
    if (!hostKind || !hostId || !targetId) {
      sendError(res, 400, 'invalid_input', 'host_kind, host_id, target_id required');
      return;
    }

    const auth = await deps.assertCanAdminHost(hostKind, hostId, userId);
    if (!auth.ok) {
      sendError(res, auth.httpStatus, auth.code, auth.message);
      return;
    }

    try {
      const threadRes = await deps.supabase
        .from('ai_threads')
        .select('id')
        .eq('use_case', COPILOT_USE_CASE)
        .eq('host_kind', hostKind)
        .eq('host_id', hostId)
        .eq('thread_key', targetId)
        .maybeSingle();

      const threadId = threadRes?.data?.id as string | undefined;
      if (!threadId) {
        res.status(200).json({ messages: [] });
        return;
      }

      const msgRes = await deps.supabase
        .from('ai_messages')
        .select('id, role, status, content, structured')
        .eq('thread_id', threadId)
        .order('created_at', { ascending: true });

      const rows = (msgRes?.data ?? []) as AiMessageRow[];
      res.status(200).json({ messages: rowsToTranscript(rows) });
    } catch (err) {
      deps.logger.warn('copilot.thread_load_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Non-fatal — an empty transcript is better than a broken pane.
      res.status(200).json({ messages: [] });
    }
  };
}
