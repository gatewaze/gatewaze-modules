// @ts-nocheck — portal deps are resolved at build time via webpack alias
//
// Calendar microsite chat sub-page.
//
// Routed by the module portal-pages registry as
// /conversations/calendars/[slug]/chat — but practically we want it to appear
// at /calendars/[slug]/chat. Since the calendars module owns the /calendars
// route prefix, this file is intentionally placed in the conversations module
// but wired up via the calendars sub-nav contract documented in
// spec-calendars-microsites §6.6 (calendarSubNav). For v1, the calendars
// module's nested route generator picks up nested directories under
// portal/pages/[slug]/, so we mirror this file in the calendars module too
// (or, in a follow-up, the registry generator collects calendarSubNav
// entries from sister modules and generates the routes).
//
// For NOW: this file documents the intended UI and is exported so a calendars
// module page can re-export it. The actual route is created by the calendars
// module's portal/pages/[slug]/chat.tsx which imports this component.

import Link from 'next/link'
import { createClient } from '@supabase/supabase-js'

interface Props {
  calendar: {
    id: string
    name: string
    slug: string | null
    calendar_id: string
  }
  viewerPersonId: string | null
  isMember: boolean
}

interface ConversationRow {
  id: string
  title: string | null
  last_message_at: string | null
}

interface MessageRow {
  id: string
  person_id: string
  content: string
  created_at: string
  is_pinned: boolean
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY!
  return createClient(url, key, {
    global: { fetch: (u, options = {}) => fetch(u, { ...options, cache: 'no-store' }) },
  })
}

export async function CalendarChatContent({ calendar, viewerPersonId, isMember }: Props) {
  // Server-side gate: must be a calendar member to see the channel
  if (!viewerPersonId) {
    return (
      <div className="text-center py-16">
        <h2 className="text-white text-2xl font-bold">Sign in to chat</h2>
        <p className="text-white/60 mt-2">
          You need to be signed in to use the {calendar.name} chat.
        </p>
        <Link
          href="/sign-in"
          className="inline-block mt-6 px-5 py-2.5 bg-white text-black text-sm font-semibold rounded-lg hover:bg-white/90"
        >
          Sign in
        </Link>
      </div>
    )
  }

  if (!isMember) {
    const slug = calendar.slug || calendar.calendar_id
    return (
      <div className="text-center py-16">
        <h2 className="text-white text-2xl font-bold">Members only</h2>
        <p className="text-white/60 mt-2">
          Join {calendar.name} to access the chat.
        </p>
        <Link
          href={`/calendars/${slug}/join`}
          className="inline-block mt-6 px-5 py-2.5 bg-white text-black text-sm font-semibold rounded-lg hover:bg-white/90"
        >
          Join this chapter
        </Link>
      </div>
    )
  }

  const supabase = getSupabase()

  // Find the calendar's default channel
  const { data: conv } = await supabase
    .from('conversations')
    .select('id, title, last_message_at')
    .eq('calendar_id', calendar.id)
    .eq('kind', 'calendar_channel')
    .eq('is_default', true)
    .maybeSingle()

  if (!conv) {
    return (
      <div className="text-center py-16">
        <h2 className="text-white text-2xl font-bold">Chat not yet available</h2>
        <p className="text-white/60 mt-2">
          A chat channel hasn't been set up for this chapter yet.
        </p>
      </div>
    )
  }

  // Fetch the most recent messages
  const { data: messages } = await supabase
    .from('conversations_messages')
    .select('id, person_id, content, created_at, is_pinned')
    .eq('conversation_id', (conv as ConversationRow).id)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
    .limit(50)

  const ordered = ((messages || []) as MessageRow[]).reverse()

  return (
    <div>
      <div className="bg-white/5 border border-white/10 rounded-xl p-4 sm:p-6">
        <h2 className="text-white text-xl font-semibold mb-4">
          {(conv as ConversationRow).title || `${calendar.name} chat`}
        </h2>

        <div className="space-y-2 max-h-[600px] overflow-y-auto">
          {ordered.length === 0 ? (
            <p className="text-white/60 text-sm text-center py-8">
              No messages yet — be the first to say hi!
            </p>
          ) : (
            ordered.map((msg) => (
              <div
                key={msg.id}
                className={`px-3 py-2 rounded ${msg.is_pinned ? 'border-l-2 border-white/40 pl-2' : ''}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-white/40 font-mono">
                    {msg.person_id.slice(0, 8)}…
                  </span>
                  <span className="text-[10px] text-white/30">
                    {new Date(msg.created_at).toLocaleString()}
                  </span>
                </div>
                <div className="text-sm text-white whitespace-pre-wrap break-words">
                  {msg.content}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-white/10 text-xs text-white/40 text-center">
          Posting requires JavaScript enabled. Real-time chat client coming soon.
        </div>
      </div>
    </div>
  )
}
