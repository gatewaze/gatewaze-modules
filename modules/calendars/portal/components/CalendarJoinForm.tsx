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
      <div className="space-y-6">
        <div className="bg-white/5 border border-white/15 rounded-2xl p-8 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/20 flex items-center justify-center">
            <svg className="w-8 h-8 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-white text-2xl font-bold">
            {alreadyAuthed ? `You're in!` : `You're in — check your email`}
          </h2>
          <p className="text-white/70 mt-3 max-w-md mx-auto">
            {alreadyAuthed
              ? `You're now a member of ${calendar.name}. You'll get updates about upcoming events.`
              : magicLinkSent
                ? <>We've sent a magic link to <span className="text-white">{email}</span>. Click it to sign in and confirm your membership.</>
                : <>You're now a member of {calendar.name}. You'll get updates about upcoming events.</>}
          </p>
          {!alreadyAuthed && magicLinkSent && (
            <p className="text-white/40 text-xs mt-6">
              Didn't get it? Check your spam folder, or{' '}
              <button
                type="button"
                onClick={() => {
                  setStatus('idle')
                  setEmail('')
                  setName('')
                  setMagicLinkSent(false)
                }}
                className="text-white/70 hover:text-white underline"
              >
                try again
              </button>
              .
            </p>
          )}
        </div>

        {nextEvents.length > 0 && (
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <h3 className="text-white font-semibold mb-4">
              Up next at {calendar.name}
            </h3>
            <div className="space-y-3">
              {nextEvents.map((ev) => (
                <Link
                  key={ev.event_id}
                  href={`/events/${ev.event_slug || ev.event_id}`}
                  className="flex items-center gap-4 p-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 transition-colors"
                >
                  {(ev.event_logo || ev.screenshot_url) ? (
                    <div
                      className="w-14 h-14 rounded-lg flex-shrink-0 bg-cover bg-center"
                      style={{ backgroundImage: `url(${ev.event_logo || ev.screenshot_url})` }}
                    />
                  ) : (
                    <div
                      className="w-14 h-14 rounded-lg flex-shrink-0"
                      style={{
                        background: ev.gradient_color_1
                          ? `linear-gradient(135deg, ${ev.gradient_color_1}, ${ev.gradient_color_2 || ev.gradient_color_1})`
                          : 'linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))',
                      }}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-white/60 text-xs">{formatShortDate(ev.event_start)}</div>
                    <div className="text-white text-sm font-medium truncate">{ev.event_title}</div>
                    {(ev.event_city || ev.event_country_code) && (
                      <div className="text-white/50 text-xs truncate">
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
      className="p-6 sm:p-8"
      style={{
        borderRadius: 'var(--radius-control, 12px)',
        backgroundColor: `rgba(var(--panel-tint, 0,0,0), var(--glass-opacity, 0.05))`,
        backdropFilter: `blur(var(--glass-blur, 4px))`,
        WebkitBackdropFilter: `blur(var(--glass-blur, 4px))`,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: `rgba(var(--panel-tint, 0,0,0), var(--glass-border-opacity, 0.1))`,
      }}
    >
      {typeof memberCount === 'number' && memberCount > 0 && (
        <div className="mb-6 flex items-center gap-2 text-white/70 text-sm">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/10">
            <svg className="w-3 h-3 text-white/70" fill="currentColor" viewBox="0 0 20 20"><path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/></svg>
          </span>
          Join <span className="text-white font-semibold">{memberCount.toLocaleString()}</span> {memberCount === 1 ? 'member' : 'members'} already on the list.
        </div>
      )}

      <div className="space-y-5">
        <div>
          <label htmlFor="name" className="block text-white/80 text-sm font-medium mb-2">
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
            className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2.5 text-white placeholder-white/40 focus:outline-none focus:border-white/50 disabled:opacity-50"
            placeholder="Jane Smith"
          />
        </div>

        <div>
          <label htmlFor="email" className="block text-white/80 text-sm font-medium mb-2">
            Email address
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={status === 'submitting'}
            className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2.5 text-white placeholder-white/40 focus:outline-none focus:border-white/50 disabled:opacity-50"
            placeholder="jane@example.com"
          />
        </div>

        {topicChips.length > 0 && (
          <div>
            <label className="block text-white/80 text-sm font-medium mb-2">
              What are you most interested in?{' '}
              <span className="text-white/50 font-normal">(optional)</span>
            </label>
            <p className="text-white/50 text-xs mb-3">
              We'll use this to highlight events you'll like.
            </p>
            <div className="flex flex-wrap gap-2">
              {topicChips.map((t) => {
                const active = interests.includes(t)
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleInterest(t)}
                    disabled={status === 'submitting'}
                    className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                      active
                        ? 'bg-white text-black border-white'
                        : 'bg-white/5 text-white/70 border-white/15 hover:border-white/30'
                    }`}
                  >
                    {t}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={emailNotifications}
              onChange={(e) => setEmailNotifications(e.target.checked)}
              disabled={status === 'submitting'}
              className="mt-1"
            />
            <span className="text-white/80 text-sm">
              Email me about upcoming events from {calendar.name}
            </span>
          </label>
        </div>

        {status === 'error' && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-200 text-sm">
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

        <p className="text-white/40 text-xs text-center">
          By joining, you agree to receive a confirmation email. You can unsubscribe any time.
        </p>
      </div>
    </form>
  )
}
