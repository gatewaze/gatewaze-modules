// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useEffect, useState } from 'react'
import { getClientBrandConfig } from '@/config/brand'
import { useAuth } from '@/hooks/useAuth'
import { ConsentNote } from './ConsentNote'

/**
 * Neutral newsletter signup using the portal's standard form styling.
 *
 * Submits via the Supabase functions URL (the way the portal makes every other client-side backend
 * call — event registration, people-signup, etc.), NOT the separate API host, which the portal client
 * can't reach. The `newsletter-signup` edge function creates the person + auth record and subscribes
 * the email to the newsletter's manually-linked list. (Interim — to be replaced by the onboarding module.)
 *
 * Signed-in users get a subscription-aware surface instead of a bare email
 * field: already-subscribed → "You're subscribed as …" + Unsubscribe; not
 * subscribed → the form prefilled with their address. Status/unsubscribe act
 * through the edge function with the USER'S JWT (the server resolves which
 * emails are theirs — including person_emails aliases — so nobody can query
 * or unsubscribe an address they don't own).
 */
export function NewsletterSignup({ collectionSlug }: { collectionSlug: string }) {
  const { user, session } = useAuth()
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'invalid' | 'error'>('idle')
  // Signed-in subscription status: undefined = unknown/loading, null = signed out.
  const [sub, setSub] = useState<{ subscribed: boolean; email: string | null } | null | undefined>(undefined)
  const [unsubState, setUnsubState] = useState<'idle' | 'working' | 'done' | 'error'>('idle')

  const fnUrl = () => `${getClientBrandConfig().supabaseUrl}/functions/v1/newsletter-signup`
  const anonHeaders = () => {
    const config = getClientBrandConfig()
    return { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey, Authorization: `Bearer ${config.supabaseAnonKey}` }
  }

  // Prefill + fetch subscription status once the session is known.
  useEffect(() => {
    let cancelled = false
    if (!session?.access_token || !user) {
      setSub(null)
      return
    }
    if (user.email) setEmail((prev) => prev || user.email)
    ;(async () => {
      try {
        const config = getClientBrandConfig()
        const res = await fetch(fnUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey, Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ action: 'status', collection: collectionSlug }),
        })
        const data = res.ok ? await res.json() : null
        if (!cancelled) setSub(data && typeof data.subscribed === 'boolean' ? data : { subscribed: false, email: null })
      } catch {
        if (!cancelled) setSub({ subscribed: false, email: null })
      }
    })()
    return () => { cancelled = true }
  }, [session?.access_token, user?.id, collectionSlug])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const value = email.trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) { setState('invalid'); return }
    setState('submitting')
    try {
      const res = await fetch(fnUrl(), {
        method: 'POST',
        headers: anonHeaders(),
        body: JSON.stringify({ email: value, collection: collectionSlug }),
      })
      if (!res.ok) throw new Error()
      setState('done')
      if (!user) setEmail('')
      setSub((prev) => (prev === null ? null : { subscribed: true, email: value.toLowerCase() }))
      setUnsubState('idle')
    } catch {
      setState('error')
    }
  }

  const unsubscribe = async () => {
    if (!session?.access_token) return
    setUnsubState('working')
    try {
      const config = getClientBrandConfig()
      const res = await fetch(fnUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey, Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action: 'unsubscribe', collection: collectionSlug }),
      })
      if (!res.ok) throw new Error()
      setUnsubState('done')
      setSub({ subscribed: false, email: null })
      setState('idle')
    } catch {
      setUnsubState('error')
    }
  }

  // Signed in + already subscribed → status + unsubscribe instead of the form.
  if (sub?.subscribed) {
    return (
      <div className="pub-nl-substate">
        <p className="pub-nl-signup-msg ok" style={{ margin: '14px 0 10px' }}>
          ✓ You’re subscribed{sub.email ? <> as <strong>{sub.email}</strong></> : null}.
        </p>
        <button type="button" className="pub-nl-unsub-btn" onClick={unsubscribe} disabled={unsubState === 'working'}>
          {unsubState === 'working' ? 'Unsubscribing…' : 'Unsubscribe'}
        </button>
        {unsubState === 'error' && <p className="pub-nl-signup-msg err">Couldn’t unsubscribe right now — please try again.</p>}
      </div>
    )
  }

  if (state === 'done') {
    return (
      <p className="pub-nl-signup-msg ok" style={{ marginTop: 14 }}>
        Thanks — you’re subscribed. Watch your inbox for the next edition.
      </p>
    )
  }

  return (
    <>
      {unsubState === 'done' && (
        <p className="pub-nl-signup-msg" style={{ marginTop: 10 }}>
          You’ve been unsubscribed. Changed your mind? Subscribe again below.
        </p>
      )}
      <form onSubmit={submit} className="pub-nl-signup">
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); if (state === 'invalid' || state === 'error') setState('idle') }}
          placeholder="Email address"
          aria-label="Email address"
          className="pub-nl-signup-input"
        />
        <button type="submit" className="pub-nl-signup-btn" disabled={state === 'submitting'}>
          {state === 'submitting' ? 'Subscribing…' : 'Subscribe'}
        </button>
        {state === 'invalid' && <p className="pub-nl-signup-msg err">Please enter a valid email address.</p>}
        {state === 'error' && <p className="pub-nl-signup-msg err">Couldn’t subscribe right now — please try again.</p>}
      </form>
      {/* Per-brand marketing-consent note (renders nothing when unconfigured). */}
      <ConsentNote />
    </>
  )
}

export default NewsletterSignup
