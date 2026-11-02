import { describe, expect, it } from 'vitest'
import {
  extractWebhookCheckedInAt,
  markRegistrationCheckedIn,
  parseCheckedInAt,
  selectLateCheckIns,
  type CheckInClient,
} from '../checkIn.ts'

const NOW = new Date('2026-11-02T18:00:00.000Z')

describe('parseCheckedInAt', () => {
  it('normalises a Luma timestamp to ISO', () => {
    expect(parseCheckedInAt('2026-10-21T17:04:12Z')).toBe('2026-10-21T17:04:12.000Z')
  })

  it('returns null for empty, missing or non-string values', () => {
    expect(parseCheckedInAt('')).toBeNull()
    expect(parseCheckedInAt('   ')).toBeNull()
    expect(parseCheckedInAt(undefined)).toBeNull()
    expect(parseCheckedInAt(null)).toBeNull()
    expect(parseCheckedInAt(42)).toBeNull()
  })

  it('returns null instead of throwing on a value that is not a date', () => {
    expect(parseCheckedInAt('not checked in')).toBeNull()
  })
})

describe('extractWebhookCheckedInAt', () => {
  it('prefers the guest checked_in_at', () => {
    expect(
      extractWebhookCheckedInAt(
        { checked_in_at: '2026-10-21T17:04:12Z', event_tickets: [{ checked_in_at: '2026-10-21T16:00:00Z' }] },
        NOW,
      ),
    ).toBe('2026-10-21T17:04:12.000Z')
  })

  it('falls back to the earliest ticket checked_in_at', () => {
    expect(
      extractWebhookCheckedInAt(
        {
          checked_in_at: null,
          event_tickets: [{ checked_in_at: '2026-10-21T18:30:00Z' }, { checked_in_at: '2026-10-21T17:10:00Z' }],
        },
        NOW,
      ),
    ).toBe('2026-10-21T17:10:00.000Z')
  })

  it('compares ticket times as instants, not as the strings Luma sent', () => {
    expect(
      extractWebhookCheckedInAt(
        { event_tickets: [{ checked_in_at: '2026-10-21T17:10:00Z' }, { checked_in_at: '2026-10-21T19:00:00+02:00' }] },
        NOW,
      ),
    ).toBe('2026-10-21T17:00:00.000Z')
  })

  it('ignores an unparseable guest time and uses the ticket time', () => {
    expect(
      extractWebhookCheckedInAt({ checked_in_at: 'garbage', event_tickets: [{ checked_in_at: '2026-10-21T17:10:00Z' }] }, NOW),
    ).toBe('2026-10-21T17:10:00.000Z')
  })

  it('reads the single event_ticket of a ticket.registered payload', () => {
    expect(extractWebhookCheckedInAt({ event_ticket: { checked_in_at: '2026-10-21T17:10:00Z' } }, NOW)).toBe(
      '2026-10-21T17:10:00.000Z',
    )
  })

  it('uses the receipt time when only a checked_in flag is set', () => {
    expect(extractWebhookCheckedInAt({ event_tickets: [{ checked_in: true }] }, NOW)).toBe(NOW.toISOString())
    expect(extractWebhookCheckedInAt({ checked_in: true }, NOW)).toBe(NOW.toISOString())
  })

  it('returns null when the guest has not checked in', () => {
    expect(extractWebhookCheckedInAt({}, NOW)).toBeNull()
    expect(extractWebhookCheckedInAt({ checked_in_at: null, event_tickets: [{ checked_in: false }] }, NOW)).toBeNull()
  })
})

describe('selectLateCheckIns', () => {
  const rows = [
    { api_id: 'gst-pending', checked_in_at: '2026-10-21T17:00:00Z' },
    { api_id: 'gst-earlier-in', checked_in_at: '2026-10-21T17:10:00Z' },
    { api_id: 'gst-earlier-not-in', checked_in_at: '' },
  ]

  it('returns check-ins only for guests an earlier upload processed', () => {
    expect(selectLateCheckIns(rows, new Set(['gst-pending']))).toEqual([
      { guestId: 'gst-earlier-in', checkedInAt: '2026-10-21T17:10:00.000Z' },
    ])
  })

  it('returns nothing when every guest is still pending', () => {
    expect(selectLateCheckIns(rows, new Set(rows.map(r => r.api_id)))).toEqual([])
  })

  it('skips rows without a guest id', () => {
    expect(selectLateCheckIns([{ checked_in_at: '2026-10-21T17:10:00Z' }], new Set())).toEqual([])
  })
})

type Row = { id: string; checked_in: boolean; checked_in_at: string | null }

/**
 * In-memory stand-in for the update().eq().is().select() chain. It applies
 * the filters to `rows` so tests assert on the resulting row state.
 */
function fakeClient(rows: Row[], fail?: { error?: string; throws?: boolean }): CheckInClient {
  return {
    from() {
      return {
        update(values: Partial<Row>) {
          const filters: Array<(r: Row) => boolean> = []
          const chain = {
            eq(col: keyof Row, val: unknown) {
              filters.push(r => r[col] === val)
              return chain
            },
            is(col: keyof Row, val: null) {
              filters.push(r => r[col] === val)
              return chain
            },
            async select() {
              if (fail?.throws) throw new Error('connection reset')
              if (fail?.error) return { data: null, error: { message: fail.error } }
              const matched = rows.filter(r => filters.every(f => f(r)))
              matched.forEach(r => Object.assign(r, values))
              return { data: matched.map(r => ({ id: r.id })), error: null }
            },
          }
          return chain
        },
      }
    },
  }
}

describe('markRegistrationCheckedIn', () => {
  it('fills an empty check-in', async () => {
    const rows: Row[] = [{ id: 'reg-1', checked_in: false, checked_in_at: null }]
    expect(await markRegistrationCheckedIn(fakeClient(rows), 'reg-1', '2026-10-21T17:10:00.000Z')).toBe('recorded')
    expect(rows[0]).toEqual({ id: 'reg-1', checked_in: true, checked_in_at: '2026-10-21T17:10:00.000Z' })
  })

  it('never overwrites a check-in that is already recorded', async () => {
    const rows: Row[] = [{ id: 'reg-1', checked_in: true, checked_in_at: '2026-10-21T16:00:00.000Z' }]
    expect(await markRegistrationCheckedIn(fakeClient(rows), 'reg-1', '2026-10-21T17:10:00.000Z')).toBe('unchanged')
    expect(rows[0].checked_in_at).toBe('2026-10-21T16:00:00.000Z')
  })

  it('only touches the registration it was given', async () => {
    const rows: Row[] = [
      { id: 'reg-1', checked_in: false, checked_in_at: null },
      { id: 'reg-2', checked_in: false, checked_in_at: null },
    ]
    await markRegistrationCheckedIn(fakeClient(rows), 'reg-1', '2026-10-21T17:10:00.000Z')
    expect(rows[1]).toEqual({ id: 'reg-2', checked_in: false, checked_in_at: null })
  })

  it('reports a database error as failed', async () => {
    const rows: Row[] = [{ id: 'reg-1', checked_in: false, checked_in_at: null }]
    expect(await markRegistrationCheckedIn(fakeClient(rows, { error: 'permission denied' }), 'reg-1', '2026-10-21T17:10:00.000Z')).toBe('failed')
    expect(rows[0].checked_in_at).toBeNull()
  })

  it('reports a thrown error as failed instead of rejecting', async () => {
    const rows: Row[] = [{ id: 'reg-1', checked_in: false, checked_in_at: null }]
    await expect(markRegistrationCheckedIn(fakeClient(rows, { throws: true }), 'reg-1', '2026-10-21T17:10:00.000Z')).resolves.toBe('failed')
  })
})
