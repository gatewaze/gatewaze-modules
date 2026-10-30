import { describe, expect, it } from 'vitest'
import { sessionConsentsTo, sessionHasAnyConsent } from '../consent.ts'

describe('sessionConsentsTo', () => {
  it('requires tracking_consent and the platform in consented_platforms', () => {
    expect(sessionConsentsTo({ tracking_consent: true, consented_platforms: ['meta', 'linkedin'] }, 'linkedin')).toBe(true)
    expect(sessionConsentsTo({ tracking_consent: true, consented_platforms: ['meta'] }, 'linkedin')).toBe(false)
    expect(sessionConsentsTo({ tracking_consent: false, consented_platforms: ['linkedin'] }, 'linkedin')).toBe(false)
  })

  it('treats an empty or missing list as no consent', () => {
    expect(sessionConsentsTo({ tracking_consent: true, consented_platforms: [] }, 'meta')).toBe(false)
    expect(sessionConsentsTo({ tracking_consent: true, consented_platforms: null }, 'meta')).toBe(false)
    expect(sessionConsentsTo({ tracking_consent: true }, 'meta')).toBe(false)
    expect(sessionConsentsTo(null, 'meta')).toBe(false)
    expect(sessionConsentsTo(undefined, 'meta')).toBe(false)
  })
})

describe('sessionHasAnyConsent', () => {
  it('is true only with consent and at least one platform', () => {
    expect(sessionHasAnyConsent({ tracking_consent: true, consented_platforms: ['reddit'] })).toBe(true)
    expect(sessionHasAnyConsent({ tracking_consent: true, consented_platforms: [] })).toBe(false)
    expect(sessionHasAnyConsent({ tracking_consent: false, consented_platforms: ['reddit'] })).toBe(false)
    expect(sessionHasAnyConsent(null)).toBe(false)
  })
})
