/**
 * Conversations Service
 *
 * Wraps the conversations table + admin_visible_conversations view.
 * Used by the top-level admin pages and the calendar/event conversation tabs.
 */

import { supabase } from '@/lib/supabase';

export type ConversationKind =
  | 'dm'
  | 'calendar_channel'
  | 'event_channel'
  | 'group_channel'
  | 'admin_channel';

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string | null;
  description: string | null;
  topic: string | null;
  calendar_id: string | null;
  event_id: string | null;
  created_by: string | null;
  is_default: boolean;
  is_archived: boolean;
  slowmode_seconds: number;
  require_username: boolean;
  visibility: 'members' | 'registered' | 'private' | 'public';
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  person_id: string;
  content: string;
  is_question: boolean;
  is_team_message: boolean;
  is_pinned: boolean;
  is_deleted: boolean;
  is_edited: boolean;
  deleted_by: string | null;
  reply_to_id: string | null;
  mentions: string[] | null;
  reaction_counts: Record<string, number>;
  moderation_flags: Record<string, unknown>;
  url_previews: unknown[];
  created_at: string;
  edited_at: string | null;
}

export interface ServiceResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export class ConversationsService {
  /**
   * List conversations the current admin can moderate, scoped automatically
   * by the admin_visible_conversations view.
   */
  static async list(
    opts: {
      kind?: ConversationKind | 'all';
      calendar_id?: string;
      event_id?: string;
      include_archived?: boolean;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<ServiceResponse<{ conversations: Conversation[]; total: number }>> {
    try {
      const limit = opts.limit ?? 50;
      const offset = opts.offset ?? 0;

      let query = supabase
        .from('admin_visible_conversations')
        .select('*', { count: 'exact' })
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .range(offset, offset + limit - 1);

      if (opts.kind && opts.kind !== 'all') {
        query = query.eq('kind', opts.kind);
      }
      if (opts.calendar_id) {
        query = query.eq('calendar_id', opts.calendar_id);
      }
      if (opts.event_id) {
        query = query.eq('event_id', opts.event_id);
      }
      if (!opts.include_archived) {
        query = query.eq('is_archived', false);
      }

      const { data, error, count } = await query;
      if (error) return { success: false, error: error.message };

      return {
        success: true,
        data: {
          conversations: (data || []) as Conversation[],
          total: count ?? data?.length ?? 0,
        },
      };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  /**
   * Get a single conversation by id (admin moderator view).
   */
  static async get(id: string): Promise<ServiceResponse<Conversation>> {
    try {
      const { data, error } = await supabase
        .from('admin_visible_conversations')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) return { success: false, error: error.message };
      if (!data) return { success: false, error: 'Conversation not found or not visible' };
      return { success: true, data: data as Conversation };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  /**
   * Get the message feed for a conversation (moderator mode — includes
   * soft-deleted messages so moderators can review).
   */
  static async getMessages(
    conversationId: string,
    opts: { limit?: number; before?: string; includeDeleted?: boolean } = {}
  ): Promise<ServiceResponse<{ messages: ConversationMessage[] }>> {
    try {
      const limit = Math.min(opts.limit ?? 100, 500);

      let query = supabase
        .from('conversations_messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (!opts.includeDeleted) {
        query = query.eq('is_deleted', false);
      }
      if (opts.before) {
        query = query.lt('created_at', opts.before);
      }

      const { data, error } = await query;
      if (error) return { success: false, error: error.message };

      const messages = (data || []).reverse() as ConversationMessage[];
      return { success: true, data: { messages } };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  /**
   * Soft-delete a message (moderator action).
   */
  static async deleteMessage(
    messageId: string,
    deletedBy: string
  ): Promise<ServiceResponse<void>> {
    try {
      const { error } = await supabase
        .from('conversations_messages')
        .update({ is_deleted: true, deleted_by: deletedBy })
        .eq('id', messageId);
      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  /**
   * Pin / unpin a message.
   */
  static async setPinned(
    messageId: string,
    pinned: boolean
  ): Promise<ServiceResponse<void>> {
    try {
      const { error } = await supabase
        .from('conversations_messages')
        .update({ is_pinned: pinned })
        .eq('id', messageId);
      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  /**
   * Block a user from a conversation.
   */
  static async blockUser(
    conversationId: string | null, // null = brand-wide block
    personId: string,
    blockedBy: string,
    reason?: string,
    expiresAt?: string
  ): Promise<ServiceResponse<void>> {
    try {
      const { error } = await supabase.from('conversations_blocked_users').insert({
        conversation_id: conversationId,
        person_id: personId,
        blocked_by: blockedBy,
        reason,
        expires_at: expiresAt,
      });
      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  /**
   * Unblock a user (delete the block row).
   */
  static async unblockUser(
    conversationId: string | null,
    personId: string
  ): Promise<ServiceResponse<void>> {
    try {
      let query = supabase
        .from('conversations_blocked_users')
        .delete()
        .eq('person_id', personId);
      if (conversationId === null) {
        query = query.is('conversation_id', null);
      } else {
        query = query.eq('conversation_id', conversationId);
      }
      const { error } = await query;
      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  /**
   * Toggle archive on a conversation.
   */
  static async setArchived(
    conversationId: string,
    archived: boolean
  ): Promise<ServiceResponse<void>> {
    try {
      const { error } = await supabase
        .from('conversations')
        .update({ is_archived: archived })
        .eq('id', conversationId);
      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  /**
   * Update slowmode on a conversation.
   */
  static async setSlowmode(
    conversationId: string,
    seconds: number
  ): Promise<ServiceResponse<void>> {
    try {
      const { error } = await supabase
        .from('conversations')
        .update({ slowmode_seconds: seconds })
        .eq('id', conversationId);
      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }
}
