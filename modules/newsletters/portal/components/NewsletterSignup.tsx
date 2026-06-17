// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useState } from 'react'

/**
 * Neutral newsletter signup using the portal's standard form styling (no per-newsletter accent
 * colour). Submits through the **forms module** like the ambassador application: POST
 * /api/forms/<slug>/submit. Defaults to a single shared `newsletter-signup` form and passes the
 * `collection` slug in the responses; a DB trigger turns the submission into a `list_subscriptions`
 * row against the collection's `subscriber_list_id`. (Interim — to be replaced by the onboarding module.)
 */
export function NewsletterSignup({
  collectionSlug,
  formSlug = 'newsletter-signup',
  apiUrl,
}: {
  collectionSlug: string
  formSlug?: string
  apiUrl?: string
}) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'invalid' | 'error'>('idle')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const value = email.trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) { setState('invalid'); return }
    setState('submitting')
    try {
      const base = apiUrl || process.env.NEXT_PUBLIC_API_URL || ''
      const res = await fetch(`${base}/api/forms/${encodeURIComponent(formSlug)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responses: { email: value, collection: collectionSlug } }),
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
    <form onSubmit={submit} className="pub-nl-signup">
      <input
        type="email"
        inputMode="email"
        autoComplete="email"
        value={email}
        onChange={(e) => { setEmail(e.target.value); if (state === 'invalid' || state === 'error') setState('idle') }}
        placeholder="you@example.com"
        aria-label="Email address"
        className="pub-nl-signup-input"
      />
      <button type="submit" className="pub-nl-signup-btn" disabled={state === 'submitting'}>
        {state === 'submitting' ? 'Subscribing…' : 'Subscribe'}
      </button>
      {state === 'invalid' && <p className="pub-nl-signup-msg err">Please enter a valid email address.</p>}
      {state === 'error' && <p className="pub-nl-signup-msg err">Couldn’t subscribe right now — please try again.</p>}
    </form>
  )
}

export default NewsletterSignup
