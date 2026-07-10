// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useEffect, useRef, useState } from 'react'
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

const fnUrl = () => `${getClientBrandConfig().supabaseUrl}/functions/v1/newsletter-signup`

/**
 * Signed-in subscription state for one collection.
 * `sub`: undefined = unknown/loading, null = signed out, else {subscribed, email}.
 * A FAILED status check never flips an established state (it only settles an
 * unknown one to not-subscribed) — surfaces like the onboarding morph swap on
 * this value, so a transient error must not yank a subscribed panel away.
 */
export function useNewsletterSubscription(collectionSlug: string) {
  const { user, session } = useAuth()
  const [sub, setSub] = useState<{ subscribed: boolean; email: string | null } | null | undefined>(undefined)
  const [unsubState, setUnsubState] = useState<'idle' | 'working' | 'done' | 'error'>('idle')
  // Token read via ref at call time: keying the effect on the access token
  // would refetch (and worse, transiently re-decide) on every token refresh.
  const sessionRef = useRef(session)
  sessionRef.current = session

  useEffect(() => {
    let cancelled = false
    if (!user) {
      setSub(null)
      return
    }
    setSub(undefined)
    ;(async () => {
      try {
        const config = getClientBrandConfig()
        const token = sessionRef.current?.access_token
        if (!token) { if (!cancelled) setSub((prev) => prev ?? { subscribed: false, email: null }); return }
        const res = await fetch(fnUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey, Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'status', collection: collectionSlug }),
        })
        const data = res.ok ? await res.json().catch(() => null) : null
        if (cancelled) return
        if (data && typeof data.subscribed === 'boolean') setSub(data)
        else setSub((prev) => prev ?? { subscribed: false, email: null })
      } catch {
        if (!cancelled) setSub((prev) => prev ?? { subscribed: false, email: null })
      }
    })()
    return () => { cancelled = true }
  }, [user?.id, collectionSlug])

  const unsubscribe = async () => {
    const token = sessionRef.current?.access_token
    if (!token) return
    setUnsubState('working')
    try {
      const config = getClientBrandConfig()
      const res = await fetch(fnUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'unsubscribe', collection: collectionSlug }),
      })
      if (!res.ok) throw new Error()
      setUnsubState('done')
      setSub({ subscribed: false, email: null })
    } catch {
      setUnsubState('error')
    }
  }

  return { user, sub, setSub, unsubState, setUnsubState, unsubscribe }
}

/** "You're subscribed as … [Unsubscribe]" — shared by the plain form and the
 *  index page's morph surface (which must not mount the morph in this state). */
export function SubscribedPanel({ sub, unsubState, unsubscribe }: {
  sub: { subscribed: boolean; email: string | null }
  unsubState: 'idle' | 'working' | 'done' | 'error'
  unsubscribe: () => void
}) {
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

export function NewsletterSignup({ collectionSlug, subscription }: {
  collectionSlug: string
  /** Pass a shared useNewsletterSubscription() so a parent surface and this
   *  form agree on one state (avoids duplicate status fetches). */
  subscription?: ReturnType<typeof useNewsletterSubscription>
}) {
  const own = useNewsletterSubscription(collectionSlug)
  const { user, sub, setSub, unsubState, unsubscribe } = subscription ?? own
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'invalid' | 'error'>('idle')

  // Prefill the signed-in user's address once known.
  useEffect(() => {
    if (user?.email) setEmail((prev) => prev || user.email)
  }, [user?.email])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const value = email.trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) { setState('invalid'); return }
    setState('submitting')
    try {
      const config = getClientBrandConfig()
      const res = await fetch(fnUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey, Authorization: `Bearer ${config.supabaseAnonKey}` },
        body: JSON.stringify({ email: value, collection: collectionSlug }),
      })
      if (!res.ok) throw new Error()
      setState('done')
      if (!user) setEmail('')
      setSub((prev) => (prev === null ? null : { subscribed: true, email: value.toLowerCase() }))
    } catch {
      setState('error')
    }
  }

  // Signed in + already subscribed → status + unsubscribe instead of the form.
  if (sub?.subscribed) {
    return <SubscribedPanel sub={sub} unsubState={unsubState} unsubscribe={unsubscribe} />
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
