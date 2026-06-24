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
    <div className="pub-wrap">
      <CalendarHeader calendar={calendar} visibility={visibility} active="" />

      {!CalendarChatContent ? (
        <div className="pub-empty" style={{ marginTop: 0 }}>
          <h2 style={{ font: '600 20px var(--font-display)', color: 'var(--ink)', margin: 0 }}>Chat not available</h2>
          <p style={{ color: 'var(--ink-3)', marginTop: 8 }}>
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
    <div
      style={{
        maxWidth: '36rem',
        margin: '0 auto',
        background: 'var(--paper)',
        border: '1px solid var(--line)',
        borderRadius: 18,
        padding: 32,
        textAlign: 'center',
      }}
    >
      <h2 style={{ font: '600 22px var(--font-display)', color: 'var(--ink)', margin: 0 }}>{title}</h2>
      <p style={{ color: 'var(--ink-3)', marginTop: 12, lineHeight: 1.55 }}>{body}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 24 }}>
        <Link href={primary.href} className="btn btn-primary">
          {primary.label}
        </Link>
        {secondary && (
          <Link href={secondary.href} className="btn btn-secondary">
            {secondary.label}
          </Link>
        )}
      </div>
    </div>
  )
}
