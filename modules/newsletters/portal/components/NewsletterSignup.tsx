// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useState } from 'react'
import { getClientBrandConfig } from '@/config/brand'
import { ConsentNote } from './ConsentNote'

/**
 * Neutral newsletter signup using the portal's standard form styling.
 *
 * Submits via the Supabase functions URL (the way the portal makes every other client-side backend
 * call — event registration, people-signup, etc.), NOT the separate API host, which the portal client
 * can't reach. The `newsletter-signup` edge function creates the person + auth record and subscribes
 * the email to the newsletter's manually-linked list. (Interim — to be replaced by the onboarding module.)
 */
export function NewsletterSignup({ collectionSlug }: { collectionSlug: string }) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'invalid' | 'error'>('idle')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const value = email.trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) { setState('invalid'); return }
    setState('submitting')
    try {
      const config = getClientBrandConfig()
      const res = await fetch(`${config.supabaseUrl}/functions/v1/newsletter-signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: config.supabaseAnonKey,
          Authorization: `Bearer ${config.supabaseAnonKey}`,
        },
        body: JSON.stringify({ email: value, collection: collectionSlug }),
      })
      if (!res.ok) throw new Error()
      setState('done')
      setEmail('')
    } catch {
      setState('error')
    }
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
