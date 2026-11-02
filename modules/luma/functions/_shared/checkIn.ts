/**
 * Luma check-in helpers. Pure (no Deno or esm.sh imports) so the workspace
 * vitest can load them.
 */

interface LumaCheckInFields {
  checked_in_at?: string | null
  checked_in?: boolean
}

export interface LumaGuestCheckIn extends LumaCheckInFields {
  event_ticket?: LumaCheckInFields
  event_tickets?: LumaCheckInFields[]
}

/** Parse a Luma check-in timestamp to ISO, or null when it is empty or not a date. */
export function parseCheckedInAt(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * When a Luma guest checked in, read from a webhook guest payload: the guest's
 * own checked_in_at, else the earliest ticket checked_in_at. A guest or ticket
 * flagged checked_in with no time falls back to `now`, since the webhook
 * arrives as the check-in happens. Null when the guest has not checked in.
 */
export function extractWebhookCheckedInAt(guest: LumaGuestCheckIn, now: Date = new Date()): string | null {
  const direct = parseCheckedInAt(guest.checked_in_at)
  if (direct) return direct

  const tickets = [guest.event_ticket, ...(guest.event_tickets ?? [])].filter(
    (t): t is LumaCheckInFields => t != null,
  )
  const ticketTimes = tickets
    .map(t => parseCheckedInAt(t.checked_in_at))
    .filter((t): t is string => t !== null)
    .sort()
  if (ticketTimes.length > 0) return ticketTimes[0]

  const flagged = guest.checked_in === true || tickets.some(t => t.checked_in === true)
  return flagged ? now.toISOString() : null
}
