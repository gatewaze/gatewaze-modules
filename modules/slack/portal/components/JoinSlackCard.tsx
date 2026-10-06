// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { getSupabaseClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/useAuth'
import { signInHref } from '@/lib/signInHref'
import { ModuleSlot, hasPortalSlot } from '@/lib/modules/ModuleSlot'
import { deriveJoinState, hasJoinFlag } from './_lib/joinState'

/**
 * "Join our Slack" — the one action on the portal Slack page.
 *
 * Signed out: the LFID sign-in button (the `sign-in:providers` module slot,
 * same as event registration's members gate) returning to `/slack?join=1`,
 * or a plain sign-in link when no provider module is installed.
 *
 * Signed in: the card calls `integrations_request_my_slack_invitation` with the
 * user's JWT. The server resolves which address is theirs; the form never sends
 * an arbitrary email. `?join=1` triggers the request once on return from
 * sign-in. Status comes from `integrations_my_slack_invitations` (own rows only).
 *
 * All hooks sit above the first return; the deps they name are declared above
 * them (see the slack portal-syntax test).
 */

const PATH = '/slack'
const RETURN_TO = `${PATH}?join=1`
// The LFID module registers the sign-in slot; nothing else does today. Keeping
// the ids here in step with <ModuleSlot> means the slot can never filter the
// button out and silently render nothing.
const SIGN_IN_MODULE_IDS = ['lfid-auth']
const SIGN_IN_FEATURES = ['lfid-auth']

interface Props {
  workspaceName: string
  workspaceUrl: string | null
  primaryColor?: string
}

export function JoinSlackCard({ workspaceName, workspaceUrl, primaryColor }: Props) {
  const { user, isLoading: authLoading } = useAuth()
  const [data, setData] = useState(undefined) // undefined = loading, null = none/signed out
  const [chosenEmail, setChosenEmail] = useState('')
  const [phase, setPhase] = useState('idle') // idle | working | error
  const [joinFlag, setJoinFlag] = useState(false)
  const autoRequested = useRef(false)

  const loadStatus = useCallback(async () => {
    try {
      const sb = getSupabaseClient()
      const { data: res, error } = await sb.rpc('integrations_my_slack_invitations')
      if (error) throw error
      setData(res ?? { emails: [], invitations: [] })
    } catch {
      setData({ emails: [], invitations: [] })
    }
  }, [])

  const request = useCallback(async (email) => {
    setPhase('working')
    try {
      const sb = getSupabaseClient()
      const { error } = await sb.rpc('integrations_request_my_slack_invitation', email ? { p_email: email } : {})
      if (error) throw error
      setPhase('idle')
      await loadStatus()
    } catch {
      setPhase('error')
    }
  }, [loadStatus])

  // The sign-in round trip returns here with ?join=1. Read it once and strip it
  // so a reload does not re-request.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (hasJoinFlag(window.location.search)) {
      setJoinFlag(true)
      try { window.history.replaceState(null, '', PATH) } catch { /* ignore */ }
    }
  }, [])

  useEffect(() => {
    if (authLoading) return
    if (!user) { setData(null); return }
    loadStatus()
  }, [authLoading, user, loadStatus])

  const state = data ? deriveJoinState(data) : null

  useEffect(() => {
    if (!joinFlag || autoRequested.current) return
    if (!user || !state || state.kind !== 'ready') return
    autoRequested.current = true
    request(null)
  }, [joinFlag, user, state, request])

  let slotAvailable = false
  try { slotAvailable = hasPortalSlot('sign-in:providers', new Set(SIGN_IN_MODULE_IDS), new Set(SIGN_IN_FEATURES)) } catch { slotAvailable = false }

  const openSlack = workspaceUrl ? (
    <p className="pub-nl-signup-msg" style={{ marginTop: 10 }}>
      Already in {workspaceName}? <a href={workspaceUrl} rel="noopener noreferrer">Open Slack</a>
    </p>
  ) : null

  // ---- signed out -------------------------------------------------------
  if (!authLoading && !user) {
    return (
      <div className="pub-nl-card">
        <h2 className="pub-nl-name">Get your invitation</h2>
        <p className="pub-nl-desc">
          Sign in with your LFID and we&apos;ll send a Slack invitation to the address on your account.
        </p>
        <div style={{ marginTop: 14 }}>
          {slotAvailable ? (
            <ModuleSlot
              name="sign-in:providers"
              enabledModuleIds={SIGN_IN_MODULE_IDS}
              enabledFeatures={SIGN_IN_FEATURES}
              props={{ redirectTo: RETURN_TO, primaryColor, soleProvider: true }}
              fallback={<Link className="pub-nl-signup-btn" href={signInHref(RETURN_TO)}>Sign in to continue</Link>}
            />
          ) : (
            <Link className="pub-nl-signup-btn" href={signInHref(RETURN_TO)}>Sign in to continue</Link>
          )}
        </div>
        {openSlack}
      </div>
    )
  }

  // ---- loading ----------------------------------------------------------
  if (authLoading || !state) {
    return (
      <div className="pub-nl-card">
        <div className="pub-empty">Checking your invitation…</div>
      </div>
    )
  }

  // ---- signed in --------------------------------------------------------
  const emails = 'emails' in state ? state.emails : []
  const multi = emails.length > 1
  const target = chosenEmail || emails[0] || ''

  const form = (
    <form
      className="pub-nl-signup"
      onSubmit={(e) => { e.preventDefault(); request(multi ? target : null) }}
    >
      {multi ? (
        <select
          className="pub-nl-signup-input"
          value={target}
          onChange={(e) => setChosenEmail(e.target.value)}
          aria-label="Email address for the invitation"
        >
          {emails.map((em) => <option key={em} value={em}>{em}</option>)}
        </select>
      ) : (
        <input className="pub-nl-signup-input" type="email" value={target} readOnly aria-label="Email address for the invitation" />
      )}
      <button type="submit" className="pub-nl-signup-btn" disabled={phase === 'working' || !target}>
        {phase === 'working' ? 'Sending…' : 'Send my invitation'}
      </button>
      {phase === 'error' && (
        <p className="pub-nl-signup-msg err">Couldn&apos;t request your invitation right now — please try again.</p>
      )}
    </form>
  )

  return (
    <div className="pub-nl-card">
      {state.kind === 'member' && (
        <>
          <h2 className="pub-nl-name">You&apos;re already in</h2>
          <p className="pub-nl-signup-msg ok">{state.email} is already a member of {workspaceName}.</p>
          {workspaceUrl && (
            <p style={{ marginTop: 14 }}>
              <a className="pub-nl-signup-btn" href={workspaceUrl} rel="noopener noreferrer">Open Slack</a>
            </p>
          )}
        </>
      )}

      {state.kind === 'queued' && (
        <>
          <h2 className="pub-nl-name">Your invitation is on its way</h2>
          <p className="pub-nl-signup-msg ok">
            We&apos;re sending a Slack invitation to {state.email}. It usually arrives within a few minutes — check your inbox (and spam folder).
          </p>
          {openSlack}
        </>
      )}

      {state.kind === 'sent' && (
        <>
          <h2 className="pub-nl-name">Invitation sent</h2>
          <p className="pub-nl-signup-msg ok">
            Slack emailed an invitation to {state.email}
            {state.at ? ` on ${new Date(state.at).toLocaleDateString()}` : ''}. Look for a message from Slack to join {workspaceName}.
          </p>
          {state.canResend ? (
            <>
              <p className="pub-nl-note" style={{ marginTop: 12 }}>Didn&apos;t get it? Request another one.</p>
              {form}
            </>
          ) : (
            <p className="pub-nl-note" style={{ marginTop: 12 }}>Invitations expire after 30 days. If it hasn&apos;t arrived in a day, you can request another one a week after the first.</p>
          )}
          {openSlack}
        </>
      )}

      {state.kind === 'failed' && (
        <>
          <h2 className="pub-nl-name">We couldn&apos;t send that one</h2>
          <p className="pub-nl-signup-msg err">Slack didn&apos;t accept an invitation for {state.email}. {multi ? 'Try another address:' : 'You can try again:'}</p>
          {form}
          {openSlack}
        </>
      )}

      {state.kind === 'ready' && (
        <>
          <h2 className="pub-nl-name">Get your invitation</h2>
          <p className="pub-nl-desc">
            {multi ? 'Choose the address Slack should invite.' : 'We’ll send the invitation to the address on your account.'}
          </p>
          {emails.length === 0 ? (
            <p className="pub-nl-signup-msg err">We couldn&apos;t find an email address on your account.</p>
          ) : form}
          {openSlack}
        </>
      )}
    </div>
  )
}
