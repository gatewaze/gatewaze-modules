import { describe, expect, it } from 'vitest'
import { splitCompanyAnswer } from '../companyAnswer.ts'

describe('splitCompanyAnswer', () => {
  it('splits "Company - Title" on the first separator', () => {
    expect(splitCompanyAnswer('Phonely - CEO')).toEqual({ company: 'Phonely', jobTitle: 'CEO' })
    expect(splitCompanyAnswer('Sinch - Sr Sales Manager - New Business')).toEqual({
      company: 'Sinch',
      jobTitle: 'Sr Sales Manager - New Business',
    })
    expect(splitCompanyAnswer('Self - Advisor / Consultant')).toEqual({ company: 'Self', jobTitle: 'Advisor / Consultant' })
  })

  it('keeps an answer without a separator as the company', () => {
    expect(splitCompanyAnswer('Deepgram')).toEqual({ company: 'Deepgram' })
    // A hyphen without spaces around it is part of the name, not a separator.
    expect(splitCompanyAnswer('mate.dev-labs')).toEqual({ company: 'mate.dev-labs' })
  })

  it('drops empty halves and non-string input', () => {
    // Trimming first means a separator at either edge is not a separator.
    expect(splitCompanyAnswer(' - CEO')).toEqual({ company: '- CEO' })
    expect(splitCompanyAnswer('Acme - ')).toEqual({ company: 'Acme -' })
    expect(splitCompanyAnswer('')).toEqual({})
    expect(splitCompanyAnswer(undefined)).toEqual({})
    expect(splitCompanyAnswer(true)).toEqual({})
  })

  it('strips control characters and caps the length of email-derived text', () => {
    expect(splitCompanyAnswer('Acme\u0000Corp\r\n - CTO\u001b')).toEqual({ company: 'Acme Corp', jobTitle: 'CTO' })
    const long = 'A'.repeat(300) + ' - ' + 'B'.repeat(50)
    const r = splitCompanyAnswer(long)
    expect(r.company).toBe('A'.repeat(200))
    expect(r.jobTitle).toBeUndefined()
    // The cap counts code points, so an emoji at the boundary stays whole.
    const emoji = 'A'.repeat(199) + '🚀' + 'B'
    expect(splitCompanyAnswer(emoji).company).toBe('A'.repeat(199) + '🚀')
  })
})
