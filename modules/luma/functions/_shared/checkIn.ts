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

/** The slice of the Supabase client markRegistrationCheckedIn uses. */
export interface CheckInClient {
  // deno-lint-ignore no-explicit-any
  from(table: string): any
}

/** Parse a Luma check-in timestamp to ISO, or null when it is empty or not a date. */
export function parseCheckedInAt(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * When a Luma guest checked in, read from a webhook guest payload. Luma's
 * documented guest payload carries the time on event_tickets[].checked_in_at;
 * a guest-level checked_in_at or a single event_ticket is read too in case
 * Luma sends them. Returns the guest time, else the earliest ticket time.
 *
 * A guest or ticket flagged checked_in with no time falls back to `now`. That
 * is the receipt time, which is late if Luma retried the delivery, and
 * markRegistrationCheckedIn never overwrites it. A later CSV re-export does
 * not correct it either. Null when the guest has not checked in.
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

/**
 * The check-ins in a CSV upload that belong to guests an earlier upload
 * already processed, so the main import loop skips them.
 */
export function selectLateCheckIns(
  approvedRows: Array<{ api_id?: string; checked_in_at?: unknown }>,
  pendingGuestIds: Set<string | undefined>,
): Array<{ guestId: string; checkedInAt: string }> {
  const lateCheckIns: Array<{ guestId: string; checkedInAt: string }> = []
  for (const row of approvedRows) {
    if (!row.api_id || pendingGuestIds.has(row.api_id)) continue
    const checkedInAt = parseCheckedInAt(row.checked_in_at)
    if (checkedInAt) lateCheckIns.push({ guestId: row.api_id, checkedInAt })
  }
  return lateCheckIns
}

export type CheckInOutcome = 'recorded' | 'unchanged' | 'failed'

/**
 * Record a Luma check-in on a registration. Only fills an empty checked_in_at,
 * so the first recorded time wins and re-imports are no-ops. The UPDATE fires
 * the engagement module's event.attended trigger. 'unchanged' means the
 * registration was already checked in (or no longer exists). Never throws, so
 * a check-in problem does not fail the import.
 */
export async function markRegistrationCheckedIn(
  supabase: CheckInClient,
  registrationId: string,
  checkedInAt: string,
): Promise<CheckInOutcome> {
  try {
    const { data, error } = await supabase
      .from('events_registrations')
      .update({ checked_in: true, checked_in_at: checkedInAt })
      .eq('id', registrationId)
      .is('checked_in_at', null)
      .select('id')

    if (error) {
      console.error(`Failed to record check-in for registration ${registrationId}:`, error.message)
      return 'failed'
    }
    return (data?.length ?? 0) > 0 ? 'recorded' : 'unchanged'
  } catch (err) {
    console.error(`Failed to record check-in for registration ${registrationId}:`, (err as Error).message)
    return 'failed'
  }
}
