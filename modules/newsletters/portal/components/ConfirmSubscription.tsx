// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useEffect, useState } from 'react'
import { getClientBrandConfig } from '@/config/brand'

/**
 * The double opt-in confirmation panel for `/newsletters?confirm=<token>`,
 * the link in a signup confirmation email.
 *
 * Scanner-safe, like the unsubscribe confirmation: loading the page only asks
 * what the token is for (`confirm-info`); the subscription is made by the
 * button's POST (`confirm`). Corporate mail scanners that open every link
 * therefore cannot subscribe anyone.
 *
 * Reads the token from window.location rather than useSearchParams, which
 * would need a Suspense boundary around the whole listing page.
 */

const fnUrl = () => `${getClientBrandConfig().supabaseUrl}/functions/v1/newsletter-signup`
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

type Info = { ok: true; email: string; newsletter: string; already: boolean } | { ok: false; reason: 'invalid' | 'expired' }

async function call(action: 'confirm-info' | 'confirm', token: string): Promise<Info> {
  const config = getClientBrandConfig()
  const res = await fetch(fnUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey, Authorization: `Bearer ${config.supabaseAnonKey}` },
    body: JSON.stringify({ action, token }),
  })
  const data = await res.json().catch(() => null)
  if (data && typeof data.ok === 'boolean') return data
  throw new Error(`confirm ${action} failed (${res.status})`)
}

export function ConfirmSubscription() {
  const [token, setToken] = useState<string | null>(null)
  const [info, setInfo] = useState<Info | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'working' | 'done' | 'error'>('loading')

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('confirm')
    if (!t) return
    setToken(t)
    if (!TOKEN_RE.test(t)) { setInfo({ ok: false, reason: 'invalid' }); setState('ready'); return }
    call('confirm-info', t)
      .then((r) => { setInfo(r); setState(r.ok && r.already ? 'done' : 'ready') })
      .catch(() => setState('error'))
  }, [])

  if (!token) return null

  const confirm = async () => {
    setState('working')
    try {
      const r = await call('confirm', token)
      setInfo(r)
      setState(r.ok ? 'done' : 'ready')
    } catch {
      setState('error')
    }
  }

  let body
  if (state === 'loading') body = <p>Checking your link…</p>
  else if (state === 'error') body = <p className="pub-nl-signup-msg err">Something went wrong — please try the link again in a moment.</p>
  else if (info && !info.ok) {
    body = (
      <p className="pub-nl-signup-msg err">
        {info.reason === 'expired'
          ? 'This confirmation link has expired. Sign up again below and we’ll send you a new one.'
          : 'This confirmation link isn’t valid. Sign up again below and we’ll send you a new one.'}
      </p>
    )
  } else if (info && info.ok && state === 'done') {
    body = (
      <p className="pub-nl-signup-msg ok">
        ✓ <strong>{info.email}</strong> is subscribed to <strong>{info.newsletter}</strong>. You can unsubscribe at any
        time from the link at the bottom of every email.
      </p>
    )
  } else if (info && info.ok) {
    body = (
      <>
        <p>
          Subscribe <strong>{info.email}</strong> to <strong>{info.newsletter}</strong>?
        </p>
        <button type="button" className="pub-nl-signup-btn" onClick={confirm} disabled={state === 'working'}>
          {state === 'working' ? 'Confirming…' : 'Confirm subscription'}
        </button>
      </>
    )
  }

  return (
    <section className="pub-nl">
      <div className="pub-nl-card">
        <div className="pub-nl-sub">
          <div className="pub-nl-sub-h">Confirm your subscription</div>
          {body}
        </div>
      </div>
    </section>
  )
}

export default ConfirmSubscription
