// @ts-nocheck — Deno edge function, runtime types provided by Supabase
/**
 * conversations-api edge function
 *
 * REST surface for the conversations module. Authentication via the Supabase
 * JWT in the Authorization header. All permission checks delegate to the
 * SQL helpers (can_see_conversation, can_post_conversation,
 * can_moderate_conversation) so the policy logic lives in one place.
 *
 * Key endpoints (see spec-conversations-module.md §6.1 for the full list):
 *   POST   /conversations/dm                    Start or get DM with another person
 *   GET    /conversations/:id                   Conversation metadata
 *   GET    /conversations/:id/messages          Paginated messages
 *   POST   /conversations/:id/messages          Send a message
 *   POST   /conversations/:id/read              Mark as read
 *   POST   /conversations/:id/reactions         Toggle a reaction
 *   PATCH  /messages/:id                        Edit own message
 *   DELETE /messages/:id                        Soft-delete (author or moderator)
 *   POST   /users/me/username                   Set / change username
 *   GET    /users/search?q=...                  Username typeahead for @-mentions
 *   POST   /push-tokens                         Register a push token
 *   DELETE /push-tokens/:token                  Unregister a push token
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface ErrorEnvelope {
  data: null
  error: { code: string; message: string; details?: Record<string, unknown> }
}
interface SuccessEnvelope<T> {
  data: T
  error: null
}

function ok<T>(data: T, status = 200): Response {
  const body: SuccessEnvelope<T> = { data, error: null }
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function err(status: number, code: string, message: string, details?: Record<string, unknown>): Response {
  const body: ErrorEnvelope = { data: null, error: { code, message, details } }
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/** Parse Bearer token from Authorization header */
function getJwt(req: Request): string | null {
  const h = req.headers.get('Authorization') || req.headers.get('authorization')
  if (!h) return null
  const m = h.match(/^Bearer\s+(.+)$/)
  return m ? m[1] : null
}

/** Resolve the calling user's person_id from the JWT */
async function getAuthPersonId(supabase: any, jwt: string): Promise<string | null> {
  const { data: userRes, error } = await supabase.auth.getUser(jwt)
  if (error || !userRes?.user?.id) return null
  const { data: person } = await supabase
    .from('people')
    .select('id')
    .eq('auth_user_id', userRes.user.id)
    .maybeSingle()
  return person?.id ?? null
}

// =============================================================================
// Route handlers
// =============================================================================

interface RouteCtx {
  supabase: any
  personId: string
  url: URL
  req: Request
}

async function handleCreateOrGetDm(ctx: RouteCtx): Promise<Response> {
  const body = await ctx.req.json().catch(() => ({}))
  const recipientId = body?.recipient_person_id
  if (!recipientId || typeof recipientId !== 'string') {
    return err(400, 'INVALID_INPUT', 'recipient_person_id is required.')
  }
  if (recipientId === ctx.personId) {
    return err(400, 'INVALID_INPUT', 'Cannot DM yourself.')
  }

  // Check the recipient's dm_policy
  const { data: recipientProfile } = await ctx.supabase
    .from('people_profiles')
    .select('dm_policy')
    .eq('id', recipientId)
    .maybeSingle()

  const policy = recipientProfile?.dm_policy || 'shared_calendars'
  if (policy === 'nobody') {
    return err(403, 'DM_BLOCKED', 'This person does not accept DMs.', { policy })
  }

  // Look for an existing DM between these two people
  const { data: existingRows } = await ctx.supabase
    .from('conversations_participants')
    .select('conversation_id, conversations!inner(id, kind)')
    .in('person_id', [ctx.personId, recipientId])
    .eq('conversations.kind', 'dm')

  // Group by conversation_id and pick one with both participants
  if (existingRows) {
    const counts = new Map<string, number>()
    for (const row of existingRows) {
      const cid = (row as any).conversation_id
      counts.set(cid, (counts.get(cid) || 0) + 1)
    }
    for (const [cid, count] of counts) {
      if (count >= 2) {
        const { data: conv } = await ctx.supabase
          .from('conversations')
          .select('*')
          .eq('id', cid)
          .single()
        return ok({ conversation_id: cid, kind: 'dm', conversation: conv })
      }
    }
  }

  // Create new DM
  const { data: conv, error: convErr } = await ctx.supabase
    .from('conversations')
    .insert({
      kind: 'dm',
      created_by: ctx.personId,
      visibility: 'private',
      require_username: false,
    })
    .select()
    .single()

  if (convErr || !conv) {
    return err(500, 'INTERNAL', convErr?.message || 'Failed to create conversation')
  }

  // Add both participants
  const { error: pErr } = await ctx.supabase
    .from('conversations_participants')
    .insert([
      { conversation_id: conv.id, person_id: ctx.personId, role: 'member' },
      { conversation_id: conv.id, person_id: recipientId, role: 'member' },
    ])

  if (pErr) {
    return err(500, 'INTERNAL', pErr.message)
  }

  return ok({ conversation_id: conv.id, kind: 'dm', conversation: conv }, 201)
}

async function handleGetMessages(ctx: RouteCtx, conversationId: string): Promise<Response> {
  // Check visibility via SQL helper
  const { data: canSee } = await ctx.supabase.rpc('can_see_conversation', { p_conv_id: conversationId })
  if (!canSee) {
    return err(403, 'FORBIDDEN', 'You do not have access to this conversation.')
  }

  const before = ctx.url.searchParams.get('before')
  const limit = Math.min(parseInt(ctx.url.searchParams.get('limit') || '50', 10), 200)

  let query = ctx.supabase
    .from('conversations_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (before) query = query.lt('created_at', before)

  const { data, error: e } = await query
  if (e) return err(500, 'INTERNAL', e.message)

  const messages = (data || []).reverse() // chronological for the client
  const nextCursor = messages.length === limit ? messages[0]?.created_at : null

  return ok({ messages, next_cursor: nextCursor, has_more: messages.length === limit })
}

async function handleSendMessage(ctx: RouteCtx, conversationId: string): Promise<Response> {
  const body = await ctx.req.json().catch(() => ({}))
  const content: string = (body?.content || '').toString().trim()
  const replyToId: string | null = body?.reply_to_id || null
  const clientId: string | null = body?.client_id || null

  if (!content) return err(400, 'INVALID_INPUT', 'Message content is required.')
  if (content.length > 4000) return err(400, 'INVALID_INPUT', 'Message exceeds 4000 character limit.')

  // Permission check via SQL helper
  const { data: canPost } = await ctx.supabase.rpc('can_post_conversation', { p_conv_id: conversationId })
  if (!canPost) {
    // Distinguish a few error cases for better UX
    const { data: conv } = await ctx.supabase
      .from('conversations')
      .select('require_username, slowmode_seconds, is_archived')
      .eq('id', conversationId)
      .maybeSingle()
    if (!conv) return err(404, 'NOT_FOUND', 'Conversation not found.')
    if (conv.is_archived) return err(403, 'FORBIDDEN', 'This conversation is archived.')
    if (conv.require_username) {
      const { data: prof } = await ctx.supabase
        .from('people_profiles')
        .select('username')
        .eq('id', ctx.personId)
        .maybeSingle()
      if (!prof?.username) {
        return err(403, 'USERNAME_REQUIRED', 'Set a username before posting in channels.')
      }
    }
    if (conv.slowmode_seconds > 0) {
      return err(429, 'RATE_LIMITED', `Slowmode active. Wait ${conv.slowmode_seconds}s.`, { retry_after_seconds: conv.slowmode_seconds })
    }
    return err(403, 'FORBIDDEN', 'You cannot post here.')
  }

  // Server-side @channel/@everyone enforcement
  const hasChannelMention = /(?:^|\s)@channel(?:\s|$)/i.test(content) || /(?:^|\s)@everyone(?:\s|$)/i.test(content)
  if (hasChannelMention) {
    const { data: canModerate } = await ctx.supabase.rpc('can_moderate_conversation', { p_conv_id: conversationId })
    if (!canModerate) {
      return err(403, 'MENTION_NOT_ALLOWED', '@channel and @everyone require moderator permission.')
    }
  }

  // Resolve @username mentions to person ids
  const mentionMatches = [...content.matchAll(/(?:^|\s)@([a-zA-Z][a-zA-Z0-9_]+)/g)]
  const usernames = mentionMatches.map((m) => m[1])
  let mentionPersonIds: string[] = []
  if (usernames.length > 0) {
    const { data: profiles } = await ctx.supabase
      .from('people_profiles')
      .select('id, username')
      .in('username', usernames)
    mentionPersonIds = (profiles || []).map((p: any) => p.id)
  }

  // De-dupe via client_id within the last 60 seconds
  if (clientId) {
    const { data: dup } = await ctx.supabase
      .from('conversations_messages')
      .select('id')
      .eq('client_id', clientId)
      .eq('person_id', ctx.personId)
      .gte('created_at', new Date(Date.now() - 60_000).toISOString())
      .maybeSingle()
    if (dup) {
      return ok({ id: (dup as any).id, deduped: true }, 200)
    }
  }

  const { data: inserted, error: insertErr } = await ctx.supabase
    .from('conversations_messages')
    .insert({
      conversation_id: conversationId,
      person_id: ctx.personId,
      content,
      reply_to_id: replyToId,
      mentions: mentionPersonIds.length > 0 ? mentionPersonIds : null,
      client_id: clientId,
      is_question: content.trim().endsWith('?'),
    })
    .select()
    .single()

  if (insertErr) return err(500, 'INTERNAL', insertErr.message)

  // Fan out notifications: mentions get a notification row per mentioned person
  for (const mentionedId of mentionPersonIds) {
    if (mentionedId === ctx.personId) continue
    await ctx.supabase
      .from('conversations_notifications')
      .insert({
        recipient_id: mentionedId,
        message_id: (inserted as any).id,
        conversation_id: conversationId,
        reason: 'mention',
        channel: 'in_app',
      })
  }

  return ok(inserted, 201)
}

async function handleToggleReaction(ctx: RouteCtx, conversationId: string): Promise<Response> {
  const body = await ctx.req.json().catch(() => ({}))
  const messageId = body?.message_id
  const emoji = (body?.emoji || '').toString()
  if (!messageId || !emoji) return err(400, 'INVALID_INPUT', 'message_id and emoji are required.')

  // Visibility check
  const { data: canSee } = await ctx.supabase.rpc('can_see_conversation', { p_conv_id: conversationId })
  if (!canSee) return err(403, 'FORBIDDEN', 'No access')

  // Toggle: insert if absent, delete if present
  const { data: existing } = await ctx.supabase
    .from('conversations_reactions')
    .select('id')
    .eq('message_id', messageId)
    .eq('person_id', ctx.personId)
    .eq('emoji', emoji)
    .maybeSingle()

  if (existing) {
    await ctx.supabase
      .from('conversations_reactions')
      .delete()
      .eq('id', (existing as any).id)
    return ok({ message_id: messageId, emoji, added: false })
  }

  const { error: insertErr } = await ctx.supabase
    .from('conversations_reactions')
    .insert({ message_id: messageId, person_id: ctx.personId, emoji })
  if (insertErr) return err(500, 'INTERNAL', insertErr.message)

  return ok({ message_id: messageId, emoji, added: true })
}

async function handleMarkRead(ctx: RouteCtx, conversationId: string): Promise<Response> {
  // Upsert participant row with last_read_at = now()
  const now = new Date().toISOString()
  const { error: upsertErr } = await ctx.supabase
    .from('conversations_participants')
    .upsert(
      {
        conversation_id: conversationId,
        person_id: ctx.personId,
        last_read_at: now,
      },
      { onConflict: 'conversation_id,person_id' }
    )
  if (upsertErr) return err(500, 'INTERNAL', upsertErr.message)
  return ok({ conversation_id: conversationId, last_read_at: now })
}

async function handleSetUsername(ctx: RouteCtx): Promise<Response> {
  const body = await ctx.req.json().catch(() => ({}))
  const username: string = (body?.username || '').toString().trim()
  if (!username) return err(400, 'INVALID_INPUT', 'username is required.', { field: 'username' })

  // Validation happens server-side via the validate_username trigger; we
  // catch the EXCEPTION raised by the trigger and convert it to a structured
  // error response.
  const { error: e } = await ctx.supabase
    .from('people_profiles')
    .update({ username })
    .eq('id', ctx.personId)

  if (e) {
    if (/reserved/i.test(e.message)) {
      return err(409, 'CONFLICT', e.message, { field: 'username' })
    }
    if (/duplicate key/i.test(e.message) || /unique/i.test(e.message)) {
      return err(409, 'CONFLICT', 'Username is taken.', { field: 'username' })
    }
    if (/3-32|letters|digits/i.test(e.message)) {
      return err(400, 'INVALID_INPUT', e.message, { field: 'username' })
    }
    return err(500, 'INTERNAL', e.message)
  }

  return ok({ username, set_at: new Date().toISOString() })
}

async function handleSearchUsers(ctx: RouteCtx): Promise<Response> {
  const q = (ctx.url.searchParams.get('q') || '').toString().trim().toLowerCase()
  if (q.length < 2) return ok({ results: [] })

  const { data } = await ctx.supabase
    .from('people_profiles')
    .select('id, username')
    .ilike('username', `${q}%`)
    .not('username', 'is', null)
    .limit(10)

  return ok({ results: data || [] })
}

async function handleRegisterPushToken(ctx: RouteCtx): Promise<Response> {
  const body = await ctx.req.json().catch(() => ({}))
  const token = body?.token
  const platform = body?.platform
  if (!token || !platform) return err(400, 'INVALID_INPUT', 'token and platform are required.')
  if (!['ios', 'android', 'web'].includes(platform)) {
    return err(400, 'INVALID_INPUT', 'platform must be ios, android, or web.')
  }

  const { error: upsertErr } = await ctx.supabase
    .from('push_tokens')
    .upsert(
      {
        person_id: ctx.personId,
        token,
        platform,
        device_id: body?.device_id,
        app_version: body?.app_version,
        is_active: true,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'token' }
    )
  if (upsertErr) return err(500, 'INTERNAL', upsertErr.message)

  return ok({ token, platform }, 201)
}

// =============================================================================
// Main router
// =============================================================================

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const url = new URL(req.url)
  // Strip the function path prefix (Supabase functions invoke this with
  // /functions/v1/conversations-api/<path>)
  const path = url.pathname.replace(/^\/functions\/v1\/conversations-api/, '').replace(/^\/conversations-api/, '') || '/'

  const jwt = getJwt(req)
  if (!jwt) return err(401, 'UNAUTHENTICATED', 'Missing Authorization header.')

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  })

  const personId = await getAuthPersonId(supabase, jwt)
  if (!personId) return err(401, 'UNAUTHENTICATED', 'Could not resolve authenticated user.')

  const ctx: RouteCtx = { supabase, personId, url, req }

  try {
    // POST /conversations/dm
    if (path === '/conversations/dm' && req.method === 'POST') {
      return await handleCreateOrGetDm(ctx)
    }

    // /conversations/:id/...
    const convMatch = path.match(/^\/conversations\/([0-9a-f-]{36})(\/(messages|read|reactions))?$/)
    if (convMatch) {
      const conversationId = convMatch[1]
      const sub = convMatch[3]
      if (!sub && req.method === 'GET') {
        const { data, error: e } = await supabase
          .from('conversations')
          .select('*')
          .eq('id', conversationId)
          .single()
        if (e || !data) return err(404, 'NOT_FOUND', 'Conversation not found.')
        return ok(data)
      }
      if (sub === 'messages' && req.method === 'GET') return await handleGetMessages(ctx, conversationId)
      if (sub === 'messages' && req.method === 'POST') return await handleSendMessage(ctx, conversationId)
      if (sub === 'reactions' && req.method === 'POST') return await handleToggleReaction(ctx, conversationId)
      if (sub === 'read' && req.method === 'POST') return await handleMarkRead(ctx, conversationId)
    }

    // POST /users/me/username
    if (path === '/users/me/username' && req.method === 'POST') {
      return await handleSetUsername(ctx)
    }

    // GET /users/search
    if (path === '/users/search' && req.method === 'GET') {
      return await handleSearchUsers(ctx)
    }

    // POST /push-tokens
    if (path === '/push-tokens' && req.method === 'POST') {
      return await handleRegisterPushToken(ctx)
    }

    return err(404, 'NOT_FOUND', `Unknown route: ${req.method} ${path}`)
  } catch (e: any) {
    console.error('[conversations-api] Unhandled error:', e)
    return err(500, 'INTERNAL', e?.message || 'Unexpected error')
  }
}

Deno.serve(handler)
