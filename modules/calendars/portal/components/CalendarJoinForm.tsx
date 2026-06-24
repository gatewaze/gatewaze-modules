// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { Calendar } from '../lib/types'
import { PortalButton } from '@/components/ui/PortalButton'

interface NextEvent {
  event_id: string
  event_slug: string | null
  event_title: string
  event_start: string | null
  event_city: string | null
  event_country_code: string | null
  event_logo: string | null
  screenshot_url: string | null
  gradient_color_1: string | null
  gradient_color_2: string | null
}

interface Props {
  calendar: Calendar
  memberCount?: number
  topicChips?: string[]
  nextEvents?: NextEvent[]
  /** Brand primary colour for the submit button glow + fill. */
  primaryColor?: string
}

type Status = 'idle' | 'submitting' | 'success' | 'error'

function formatShortDate(iso: string | null): string {
  if (!iso) return 'TBA'
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

export function CalendarJoinForm({
  calendar,
  memberCount,
  topicChips = [],
  nextEvents = [],
  primaryColor,
}: Props) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [emailNotifications, setEmailNotifications] = useState(true)
  const [interests, setInterests] = useState<string[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [magicLinkSent, setMagicLinkSent] = useState(false)
  const [alreadyAuthed, setAlreadyAuthed] = useState(false)

  function toggleInterest(t: string) {
    setInterests((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus('submitting')
    setErrorMessage('')

    try {
      const res = await fetch('/api/calendar-members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendar_id: calendar.id,
          name,
          email,
          notification_preferences: {
            email: emailNotifications,
            sms: false,
            push: false,
          },
          marketing_consent: false,
          interests,
        }),
      })

      const body = await res.json().catch(() => ({}))

      if (!res.ok) {
        const message = body?.error?.message || 'Something went wrong. Please try again.'
        setErrorMessage(message)
        setStatus('error')
        return
      }

      setMagicLinkSent(!!body?.data?.magic_link_sent)
      setAlreadyAuthed(!!body?.data?.already_authed)
      setStatus('success')
    } catch (err) {
      setErrorMessage('Network error. Please check your connection and try again.')
      setStatus('error')
    }
  }

  if (status === 'success') {
    return (
      <div className="cal-join" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <CalJoinStyles />
        <div className="cal-join-panel" style={{ textAlign: 'center' }}>
          <div style={{ width: 64, height: 64, margin: '0 auto 16px', borderRadius: '50%', background: 'rgba(34,197,94,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="#22c55e">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 style={{ font: '600 24px var(--font-display)', color: 'var(--ink)', margin: 0 }}>
            {alreadyAuthed ? `You're in!` : `You're in — check your email`}
          </h2>
          <p style={{ color: 'var(--ink-3)', marginTop: 12, maxWidth: '28rem', marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.55 }}>
            {alreadyAuthed
              ? `You're now a member of ${calendar.name}. You'll get updates about upcoming events.`
              : magicLinkSent
                ? <>We've sent a magic link to <span style={{ color: 'var(--ink)' }}>{email}</span>. Click it to sign in and confirm your membership.</>
                : <>You're now a member of {calendar.name}. You'll get updates about upcoming events.</>}
          </p>
          {!alreadyAuthed && magicLinkSent && (
            <p style={{ color: 'var(--ink-4)', fontSize: 12, marginTop: 24 }}>
              Didn't get it? Check your spam folder, or{' '}
              <button
                type="button"
                onClick={() => {
                  setStatus('idle')
                  setEmail('')
                  setName('')
                  setMagicLinkSent(false)
                }}
                style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--ink-3)', textDecoration: 'underline', font: 'inherit' }}
              >
                try again
              </button>
              .
            </p>
          )}
        </div>

        {nextEvents.length > 0 && (
          <div className="cal-join-panel">
            <h3 style={{ font: '600 16px var(--font-display)', color: 'var(--ink)', margin: '0 0 16px' }}>
              Up next at {calendar.name}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {nextEvents.map((ev) => (
                <Link
                  key={ev.event_id}
                  href={`/events/${ev.event_slug || ev.event_id}`}
                  className="cal-join-evrow"
                >
                  {(ev.event_logo || ev.screenshot_url) ? (
                    <div
                      style={{ width: 56, height: 56, borderRadius: 11, flexShrink: 0, backgroundImage: `url(${ev.event_logo || ev.screenshot_url})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 56, height: 56, borderRadius: 11, flexShrink: 0,
                        background: ev.gradient_color_1
                          ? `linear-gradient(135deg, ${ev.gradient_color_1}, ${ev.gradient_color_2 || ev.gradient_color_1})`
                          : 'rgba(var(--ui-text), 0.06)',
                      }}
                    />
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ color: 'var(--ink-4)', fontSize: 12 }}>{formatShortDate(ev.event_start)}</div>
                    <div style={{ color: 'var(--ink)', fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.event_title}</div>
                    {(ev.event_city || ev.event_country_code) && (
                      <div style={{ color: 'var(--ink-3)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {[ev.event_city, ev.event_country_code].filter(Boolean).join(', ')}
                      </div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <form
      onSubmit={handleSubmit}
      // suppressHydrationWarning: browser extensions like LastPass / 1Password
      // inject decorative DOM nodes into form inputs after hydration. Their
      // mutations land before React diffs and produce a hydration error.
      // The warning is scoped to this subtree only.
      suppressHydrationWarning
      className="cal-join-panel"
    >
      <CalJoinStyles />
      {typeof memberCount === 'number' && memberCount > 0 && (
        <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ink-3)', fontSize: 14 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: '50%', background: 'rgba(var(--ui-text), 0.1)' }}>
            <svg width="13" height="13" fill="currentColor" viewBox="0 0 20 20" style={{ color: 'var(--ink-3)' }}><path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/></svg>
          </span>
          Join <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{memberCount.toLocaleString()}</span> {memberCount === 1 ? 'member' : 'members'} already on the list.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div>
          <label htmlFor="name" className="cal-join-label">
            Your name
          </label>
          <input
            id="name"
            type="text"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={status === 'submitting'}
            className="cal-join-input"
            placeholder="Jane Smith"
          />
        </div>

        <div>
          <label htmlFor="email" className="cal-join-label">
            Email address
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={status === 'submitting'}
            className="cal-join-input"
            placeholder="jane@example.com"
          />
        </div>

        {topicChips.length > 0 && (
          <div>
            <label className="cal-join-label">
              What are you most interested in?{' '}
              <span style={{ color: 'var(--ink-4)', fontWeight: 400 }}>(optional)</span>
            </label>
            <p style={{ color: 'var(--ink-4)', fontSize: 12, margin: '0 0 12px' }}>
              We'll use this to highlight events you'll like.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {topicChips.map((t) => {
                const active = interests.includes(t)
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleInterest(t)}
                    disabled={status === 'submitting'}
                    className={`cal-join-chip${active ? ' on' : ''}`}
                  >
                    {t}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={emailNotifications}
              onChange={(e) => setEmailNotifications(e.target.checked)}
              disabled={status === 'submitting'}
              style={{ marginTop: 4 }}
            />
            <span style={{ color: 'var(--ink-2)', fontSize: 14 }}>
              Email me about upcoming events from {calendar.name}
            </span>
          </label>
        </div>

        {status === 'error' && (
          <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10, padding: '12px 16px', color: '#fca5a5', fontSize: 14 }}>
            {errorMessage}
          </div>
        )}

        <PortalButton
          variant="primary"
          glow
          type="submit"
          primaryColor={primaryColor}
          disabled={status === 'submitting' || !name || !email}
          isLoading={status === 'submitting'}
          className="w-full"
        >
          {status === 'submitting' ? 'Joining…' : 'Join this calendar'}
        </PortalButton>

        <p style={{ color: 'var(--ink-4)', fontSize: 12, textAlign: 'center', margin: 0 }}>
          By joining, you agree to receive a confirmation email. You can unsubscribe any time.
        </p>
      </div>
    </form>
  )
}

/**
 * Shared scoped styles for the join form's panels, inputs and chips. Rendered
 * once inside whichever branch (success or form) is active.
 */
function CalJoinStyles() {
  return (
    <style>{`
      .cal-join-panel { background: var(--paper); border: 1px solid var(--line); border-radius: 18px; padding: 24px; }
      @media (min-width: 640px) { .cal-join-panel { padding: 32px; } }
      .cal-join-label { display: block; color: var(--ink-2); font-size: 14px; font-weight: 500; margin-bottom: 8px; }
      .cal-join-input { width: 100%; box-sizing: border-box; background: rgba(var(--ui-text), 0.08); border: 1px solid rgba(var(--ui-text), 0.18);
        border-radius: 10px; padding: 10px 14px; color: var(--ink); font-size: 14px; }
      .cal-join-input::placeholder { color: var(--ink-4); }
      .cal-join-input:disabled { opacity: 0.5; }
      .cal-join-chip { padding: 5px 12px; font-size: 12px; border-radius: 999px; cursor: pointer; transition: border-color .15s ease, background .15s ease;
        background: rgba(var(--ui-text), 0.05); color: var(--ink-3); border: 1px solid var(--line); }
      .cal-join-chip:hover { border-color: var(--line-2); }
      .cal-join-chip.on { background: var(--ink); color: var(--paper); border-color: var(--ink); }
      .cal-join-chip:disabled { opacity: 0.5; cursor: default; }
      .cal-join-evrow { display: flex; align-items: center; gap: 16px; padding: 12px; border-radius: 12px; text-decoration: none;
        background: rgba(var(--ui-text), 0.04); border: 1px solid var(--line); transition: border-color .15s ease, background .15s ease; }
      .cal-join-evrow:hover { border-color: var(--line-2); background: rgba(var(--ui-text), 0.06); }
    `}</style>
  )
}
