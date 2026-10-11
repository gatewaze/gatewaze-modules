/**
 * Pure view-state for the portal "Join Slack" card. Kept out of the .tsx so it
 * can be unit-tested (module portal pages are never typechecked or rendered by
 * the test suite).
 */

export type Outcome = 'queued' | 'sent' | 'member' | 'failed'

export interface MyInvitation {
  email: string
  outcome: Outcome
  invited_at: string | null
  requested_at: string
  updated_at: string
}

export interface MyEmail {
  email: string
  is_primary: boolean
}

export interface MyInvitations {
  emails: MyEmail[]
  invitations: MyInvitation[]
}

export type JoinState =
  | { kind: 'ready'; emails: string[] }
  | { kind: 'queued'; email: string }
  | { kind: 'sent'; email: string; at: string | null; canResend: boolean; emails: string[] }
  | { kind: 'member'; email: string }
  | { kind: 'failed'; email: string; emails: string[] }

/** Matches the request RPC's 7-day dedupe window. */
export const RESEND_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Decide what the card shows from the caller's addresses and their latest
 * invitation per address. Precedence: already a member beats everything (there
 * is nothing left to do), then an invite in flight, then one already sent,
 * then a failure the visitor may retry, else the request form.
 */
export function deriveJoinState(data: MyInvitations | null | undefined, now: number = Date.now()): JoinState {
  const emails = (data?.emails ?? []).map((e) => e.email)
  const invitations = data?.invitations ?? []

  const byOutcome = (o: Outcome) => invitations.find((i) => i.outcome === o)

  const member = byOutcome('member')
  if (member) return { kind: 'member', email: member.email }

  const queued = byOutcome('queued')
  if (queued) return { kind: 'queued', email: queued.email }

  const sent = byOutcome('sent')
  if (sent) {
    const at = sent.invited_at ?? sent.updated_at ?? null
    const ageMs = at ? now - Date.parse(at) : Number.POSITIVE_INFINITY
    return { kind: 'sent', email: sent.email, at, canResend: ageMs >= RESEND_AFTER_MS, emails }
  }

  const failed = byOutcome('failed')
  if (failed) return { kind: 'failed', email: failed.email, emails }

  return { kind: 'ready', emails }
}

/** "general, #introduce-yourself ,job-posts" → ['general', 'introduce-yourself', 'job-posts'] */
export function parseChannels(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/[,\n]/)
    .map((c) => c.trim().replace(/^#/, ''))
    .filter((c) => c.length > 0 && c.length <= 80)
}

/** The `?join=1` flag the sign-in round trip carries back to the page. */
export function hasJoinFlag(search: string | null | undefined): boolean {
  if (!search) return false
  try {
    return new URLSearchParams(search).get('join') === '1'
  } catch {
    return false
  }
}
