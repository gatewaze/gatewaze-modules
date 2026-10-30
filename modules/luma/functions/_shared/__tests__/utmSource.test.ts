import { describe, expect, it } from 'vitest'
import { UTM_SOURCE_MAX_LENGTH, extractTrackingSessionId, extractUtmSource, sanitizeUtmSource } from '../utmSource.ts'

const emailBody = (line: string) =>
  [
    'Shiwans Vaishya',
    'registered for your event',
    '',
    'Shiwans Vaishya: https://luma.com/event/manage/evt-yYHCTDA7lPLjr1F/guests?uid=usr-TCXMSTnzTxxcSS3 has registered for Agentic AI Day.',
    '',
    line,
    '',
    'They answered the following 4 questions:',
    ' * What is your LinkedIn profile? /in/example',
  ].join('\n')

describe('extractUtmSource', () => {
  it('reads a plain source', () => {
    expect(extractUtmSource(emailBody(' * UTM source for the registration was facebook.'))).toBe('facebook')
  })

  it('keeps dots inside the value and drops only the trailing full stop', () => {
    expect(extractUtmSource(emailBody(' * UTM source for the registration was chatgpt.com.'))).toBe('chatgpt.com')
    expect(extractUtmSource(emailBody(' * UTM source for the registration was blog.techeurope.io.'))).toBe(
      'blog.techeurope.io'
    )
  })

  it('keeps the tracking-redirect shape intact', () => {
    expect(extractUtmSource(emailBody('UTM source for the registration was meta__ml7xo47p-dmsby75m.'))).toBe(
      'meta__ml7xo47p-dmsby75m'
    )
  })

  it('handles CRLF line endings and a line at the end of the body', () => {
    expect(extractUtmSource('x\r\nUTM source for the registration was linkedin.\r\nnext')).toBe('linkedin')
    expect(extractUtmSource('x\nUTM source for the registration was linkedin.')).toBe('linkedin')
  })

  it('caps the value and drops control characters', () => {
    const long = 'a'.repeat(500)
    expect(extractUtmSource(`UTM source for the registration was ${long}.`)).toHaveLength(UTM_SOURCE_MAX_LENGTH)
    expect(sanitizeUtmSource('face\u0000book\u001b')).toBe('facebook')
    expect(sanitizeUtmSource('   ')).toBeNull()
  })

  it('returns null when the line is absent or empty', () => {
    expect(extractUtmSource(emailBody('They paid $0 for their ticket.'))).toBeNull()
    expect(extractUtmSource('UTM source for the registration was .')).toBeNull()
    expect(extractUtmSource(null)).toBeNull()
    expect(extractUtmSource('')).toBeNull()
  })
})

describe('extractTrackingSessionId', () => {
  it('returns the session half of a platform__session value', () => {
    expect(extractTrackingSessionId('meta__ml7xo47p-dmsby75m')).toBe('ml7xo47p-dmsby75m')
    expect(extractTrackingSessionId('direct__abc-def')).toBe('abc-def')
  })

  it('returns null for plain sources', () => {
    expect(extractTrackingSessionId('facebook')).toBeNull()
    expect(extractTrackingSessionId('chatgpt.com')).toBeNull()
    expect(extractTrackingSessionId('meta__')).toBeNull()
    expect(extractTrackingSessionId(undefined)).toBeNull()
  })

  it('rejects session ids outside the portal shape', () => {
    expect(extractTrackingSessionId('meta__abc.def')).toBeNull()
    expect(extractTrackingSessionId('meta__' + 'x'.repeat(65))).toBeNull()
    expect(extractTrackingSessionId("meta__' or 1=1")).toBeNull()
    expect(extractTrackingSessionId('meta__ok_id-1')).toBe('ok_id-1')
  })
})
