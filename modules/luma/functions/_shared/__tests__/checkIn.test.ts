import { describe, expect, it } from 'vitest'
import { extractWebhookCheckedInAt, parseCheckedInAt } from '../checkIn.ts'

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
