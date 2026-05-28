// @ts-nocheck — portal deps are resolved at build time via webpack alias
import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  getCalendarWithEvents,
  getCalendarSubNavVisibility,
  getViewerPersonId,
  isViewerActiveMember,
} from '../../lib/calendars'
import { CalendarHeader } from '../../components/CalendarHeader'

interface Props {
  params: { slug: string }
}

/**
 * Calendar microsite chat sub-page.
 *
 * Routed by the calendars module's portal pages tree at /calendars/[slug]/chat.
 * The actual chat rendering logic lives in the conversations module
 * (modules/conversations/portal/calendar-pages/chat.tsx) and is imported here
 * lazily — if the conversations module isn't installed, the route renders
 * "chat is not available on this brand" instead of crashing.
 */
export default async function CalendarChatPage({ params }: Props) {
  const slug = params.slug
  const result = await getCalendarWithEvents(slug)
  if (!result) notFound()

  const { calendar } = result
  const canonicalSlug = calendar.slug || calendar.calendar_id

  const viewerPersonId = await getViewerPersonId()
  const isMember = await isViewerActiveMember(calendar.id, viewerPersonId)
  const visibility = await getCalendarSubNavVisibility(calendar.id, viewerPersonId)

  // Lazy import the conversations module's chat content. If the module isn't
  // installed (the import path doesn't resolve), we render a fallback.
  let CalendarChatContent: any = null
  try {
    const mod = await import(
      /* @vite-ignore */ '../../../../conversations/portal/calendar-pages/chat'
    )
    CalendarChatContent = mod.CalendarChatContent
  } catch {
    // Module not installed
  }

  return (
    <main className="relative z-10">
      <div className="max-w-7xl mx-auto px-6 sm:px-6 lg:px-8 py-8 sm:py-12">
        <CalendarHeader calendar={calendar} visibility={visibility} active="" />

        {!CalendarChatContent ? (
          <div className="text-center py-16">
            <h2 className="text-white text-2xl font-bold">Chat not available</h2>
            <p className="text-white/60 mt-2">
              The conversations module is not installed on this brand.
            </p>
          </div>
        ) : !viewerPersonId ? (
          <ChatGate
            title="Sign in to join the conversation"
            body={`The ${calendar.name} chat is for members. Sign in or create an account, then join this calendar to start posting.`}
            primary={{ href: `/auth/sign-in?next=${encodeURIComponent(`/calendars/${canonicalSlug}/chat`)}`, label: 'Sign in' }}
            secondary={{ href: `/calendars/${canonicalSlug}/join`, label: 'Join calendar' }}
          />
        ) : !isMember ? (
          <ChatGate
            title="Join this calendar to chat"
            body={`You're signed in, but you're not yet a member of ${calendar.name}. Join to read and post in the chat.`}
            primary={{ href: `/calendars/${canonicalSlug}/join`, label: 'Join this calendar' }}
          />
        ) : (
          <CalendarChatContent
            calendar={calendar}
            viewerPersonId={viewerPersonId}
            isMember={isMember}
          />
        )}
      </div>
    </main>
  )
}

function ChatGate({
  title,
  body,
  primary,
  secondary,
}: {
  title: string
  body: string
  primary: { href: string; label: string }
  secondary?: { href: string; label: string }
}) {
  return (
    <div className="max-w-xl mx-auto bg-white/5 border border-white/15 rounded-2xl p-8 text-center">
      <h2 className="text-white text-2xl font-bold">{title}</h2>
      <p className="text-white/70 mt-3">{body}</p>
      <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
        <Link
          href={primary.href}
          className="px-5 py-2.5 rounded-lg bg-white text-black font-semibold text-sm hover:bg-white/90"
        >
          {primary.label}
        </Link>
        {secondary && (
          <Link
            href={secondary.href}
            className="px-5 py-2.5 rounded-lg bg-white/10 text-white font-medium text-sm hover:bg-white/20"
          >
            {secondary.label}
          </Link>
        )}
      </div>
    </div>
  )
}
