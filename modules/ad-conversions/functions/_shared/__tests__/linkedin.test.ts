import { describe, expect, it } from 'vitest'
import {
  buildConversionEvent,
  buildUserIds,
  linkedInHeaders,
  pickConversionUrn,
  toConversionUrn,
  LINKEDIN_MAX_EVENT_AGE_MS,
} from '../linkedin.ts'

const config = { conversion_id: '123', access_token: 'tok', purchase_conversion_id: '456' }

describe('toConversionUrn', () => {
  it('wraps a bare id and keeps a full urn', () => {
    expect(toConversionUrn('123')).toBe('urn:lla:llaPartnerConversion:123')
    expect(toConversionUrn(' urn:lla:llaPartnerConversion:9 ')).toBe('urn:lla:llaPartnerConversion:9')
  })
})

describe('pickConversionUrn', () => {
  it('uses the purchase rule only for paid registrations when configured', () => {
    expect(pickConversionUrn(config, 50)).toBe('urn:lla:llaPartnerConversion:456')
    expect(pickConversionUrn(config, 0)).toBe('urn:lla:llaPartnerConversion:123')
    expect(pickConversionUrn(config, null)).toBe('urn:lla:llaPartnerConversion:123')
    expect(pickConversionUrn({ conversion_id: '1', access_token: 't' }, 50)).toBe('urn:lla:llaPartnerConversion:1')
  })
})

describe('buildUserIds', () => {
  it('always sends the hashed email and adds the click id and ip when known', () => {
    expect(buildUserIds({ hashedEmail: 'abc' })).toEqual([{ idType: 'SHA256_EMAIL', idValue: 'abc' }])
    expect(buildUserIds({ hashedEmail: 'abc', liFatId: 'li-1', ipAddress: '1.2.3.4' })).toEqual([
      { idType: 'SHA256_EMAIL', idValue: 'abc' },
      { idType: 'LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID', idValue: 'li-1' },
      { idType: 'PLAINTEXT_IP_ADDRESS', idValue: '1.2.3.4' },
    ])
    expect(buildUserIds({ hashedEmail: 'abc', liFatId: null, ipAddress: '' })).toHaveLength(1)
  })
})

describe('buildConversionEvent', () => {
  const now = new Date('2026-10-30T12:00:00Z')
  const userIds = buildUserIds({ hashedEmail: 'abc' })

  it('sends milliseconds, the event id, and no value for a free registration', () => {
    const ev = buildConversionEvent({
      config,
      happenedAt: new Date('2026-10-29T10:00:00Z'),
      now,
      eventId: 'reg_1',
      userIds,
      amountPaid: null,
    })
    expect(ev).toEqual({
      conversion: 'urn:lla:llaPartnerConversion:123',
      conversionHappenedAt: Date.UTC(2026, 9, 29, 10, 0, 0),
      user: { userIds },
      eventId: 'reg_1',
    })
    expect(ev.conversionValue).toBeUndefined()
  })

  it('adds a value and the purchase rule for a paid registration', () => {
    const ev = buildConversionEvent({
      config,
      happenedAt: now,
      now,
      eventId: 'reg_2',
      userIds,
      amountPaid: 300,
      currency: 'usd',
    })
    expect(ev.conversion).toBe('urn:lla:llaPartnerConversion:456')
    expect(ev.conversionValue).toEqual({ currencyCode: 'USD', amount: '300.00' })
  })

  it('never sends a future timestamp and clamps into the 90 day window', () => {
    const future = buildConversionEvent({
      config,
      happenedAt: new Date(now.getTime() + 60_000),
      now,
      eventId: 'x',
      userIds,
    })
    expect(future.conversionHappenedAt).toBe(now.getTime())

    const old = buildConversionEvent({
      config,
      happenedAt: new Date(now.getTime() - 2 * LINKEDIN_MAX_EVENT_AGE_MS),
      now,
      eventId: 'y',
      userIds,
    })
    expect(old.conversionHappenedAt).toBeGreaterThan(now.getTime() - LINKEDIN_MAX_EVENT_AGE_MS)
    expect(old.conversionHappenedAt).toBeLessThan(now.getTime())
  })
})

describe('linkedInHeaders', () => {
  it('sets the versioned headers LinkedIn requires', () => {
    expect(linkedInHeaders(config)).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
      'LinkedIn-Version': '202610',
      'X-Restli-Protocol-Version': '2.0.0',
    })
    expect(linkedInHeaders({ ...config, api_version: '202701' })['LinkedIn-Version']).toBe('202701')
  })
})
