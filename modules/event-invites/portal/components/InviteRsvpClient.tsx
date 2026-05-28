'use client'

import { useState, useEffect, useMemo, useRef } from 'react'

interface Question {
  id: string
  question_text: string
  question_type: 'select' | 'multi_select' | 'text' | 'yes_no'
  options: string[] | null
  is_required: boolean
  current_answer: unknown
}

interface MemberEvent {
  member_event_id: string
  event_id: string
  event_title: string
  event_start: string | null
  event_end: string | null
  event_location: string | null
  rsvp_status: string
  rsvp_deadline: string | null
  rsvp_responded_at: string | null
  questions: Question[]
}

interface Member {
  id: string
  first_name: string | null
  last_name: string | null
  is_lead_booker: boolean
  is_plus_one: boolean
  events: MemberEvent[]
}

interface Party {
  id: string
  name: string
  status: string
  max_plus_ones: number
  plus_ones_added: number
  version: number
}

interface InviteRsvpProps {
  party: Party
  members: Member[]
  token: string
  primaryColor: string
  brandName: string
}

interface RsvpEntry {
  rsvp_status: string
  answers: Record<string, unknown>
}

interface NewPlusOne {
  first_name: string
  last_name: string
  event_ids: string[]
  rsvp_statuses: Record<string, string>
  answers: { event_id: string; question_id: string; answer: unknown }[]
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  // Use UTC to avoid server/client timezone hydration mismatch
  const d = new Date(dateStr)
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} at ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function isDeadlinePassed(deadline: string | null): boolean {
  if (!deadline) return false
  return new Date(deadline) < new Date()
}

function getMemberName(m: { first_name: string | null; last_name: string | null }): string {
  return [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Guest'
}

export function InviteRsvpClient({ party, members, token, primaryColor, brandName }: InviteRsvpProps) {
  const [rsvpData, setRsvpData] = useState<Record<string, RsvpEntry>>({})
  const [plusOnes, setPlusOnes] = useState<NewPlusOne[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [submitResult, setSubmitResult] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => { setMounted(true) }, [])

  const allEvents = useMemo(() => {
    const eventMap = new Map<string, { event_id: string; event_title: string; questions: Question[] }>()
    for (const m of members) {
      for (const e of m.events) {
        if (!eventMap.has(e.event_id)) {
          eventMap.set(e.event_id, { event_id: e.event_id, event_title: e.event_title, questions: e.questions })
        }
      }
    }
    return Array.from(eventMap.values())
  }, [members])

  const remainingPlusOnes = party.max_plus_ones - party.plus_ones_added - plusOnes.length

  useEffect(() => {
    const initial: Record<string, RsvpEntry> = {}
    for (const member of members) {
      for (const event of member.events) {
        const answers: Record<string, unknown> = {}
        for (const q of event.questions) {
          if (q.current_answer != null) answers[q.id] = q.current_answer
        }
        initial[event.member_event_id] = { rsvp_status: event.rsvp_status, answers }
      }
    }
    setRsvpData(initial)
  }, [members])

  useEffect(() => {
    try { localStorage.setItem('invite_short_code', token) } catch { /* ignore */ }
  }, [token])

  const updateRsvp = (memberEventId: string, status: string) => {
    setRsvpData(prev => ({
      ...prev,
      [memberEventId]: { ...prev[memberEventId], rsvp_status: status },
    }))
  }

  const updateAnswer = (memberEventId: string, questionId: string, answer: unknown) => {
    setRsvpData(prev => ({
      ...prev,
      [memberEventId]: {
        ...prev[memberEventId],
        answers: { ...prev[memberEventId]?.answers, [questionId]: answer },
      },
    }))
  }

  const addPlusOne = () => {
    setPlusOnes(prev => [...prev, {
      first_name: '', last_name: '',
      event_ids: allEvents.map(e => e.event_id),
      rsvp_statuses: Object.fromEntries(allEvents.map(e => [e.event_id, 'accepted'])),
      answers: [],
    }])
  }

  const removePlusOne = (index: number) => {
    setPlusOnes(prev => prev.filter((_, i) => i !== index))
  }

  const updatePlusOne = (index: number, field: string, value: unknown) => {
    setPlusOnes(prev => prev.map((po, i) => i === index ? { ...po, [field]: value } : po))
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    setError(null)

    try {
      const responses = Object.entries(rsvpData).map(([member_event_id, data]) => ({
        member_event_id,
        rsvp_status: data.rsvp_status,
        answers: Object.entries(data.answers)
          .filter(([, v]) => v != null && v !== '')
          .map(([question_id, answer]) => ({ question_id, answer })),
      }))

      const body: Record<string, unknown> = {
        action: 'submit', token, version: party.version, responses,
      }

      if (plusOnes.length > 0) {
        body.new_plus_ones = plusOnes.filter(po => po.first_name || po.last_name)
      }

      const res = await fetch('/api/invite-rsvp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const result = await res.json()

      if (!res.ok) {
        const messages: Record<string, string> = {
          VERSION_CONFLICT: 'Someone else updated this RSVP. Please refresh and try again.',
          VALIDATION_ERROR: 'Please fill in all required fields.',
          DEADLINE_PASSED: 'The RSVP deadline has passed for some events.',
          PLUS_ONE_LIMIT: result.message || 'Plus-one limit exceeded.',
        }
        setError(messages[result.error] || result.message || 'Something went wrong.')
        return
      }

      setSubmitResult(result)
      setSubmitted(true)
    } catch {
      setError('Network error. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted && submitResult) {
    const summary = submitResult.summary as Record<string, number>
    return (
      <div className="bg-white/10 backdrop-blur-sm rounded-2xl border border-white/10 p-8 text-center">
        <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6" style={{ backgroundColor: `${primaryColor}30`, animation: 'rsvp-pop 0.4s cubic-bezier(0.34,1.56,0.64,1) both' }}>
          <svg className="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 13l4 4L19 7" style={{ strokeDasharray: 24, strokeDashoffset: 24, animation: 'rsvp-draw 0.5s 0.3s ease forwards' }} />
          </svg>
        </div>
        <style>{`
          @keyframes rsvp-draw { to { stroke-dashoffset: 0; } }
          @keyframes rsvp-pop { 0% { transform: scale(0); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
        `}</style>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">RSVP Confirmed!</h2>
        <p className="text-gray-500 mb-6">Thank you for responding, {party.name}.</p>
        <div className="flex justify-center gap-6 text-sm mb-6">
          {summary.accepted > 0 && (
            <div className="text-center">
              <p className="text-2xl font-bold text-green-400">{summary.accepted}</p>
              <p className="text-gray-500">Attending</p>
            </div>
          )}
          {summary.declined > 0 && (
            <div className="text-center">
              <p className="text-2xl font-bold text-red-400">{summary.declined}</p>
              <p className="text-gray-500">Not attending</p>
            </div>
          )}
          {(summary.plus_ones_added || 0) > 0 && (
            <div className="text-center">
              <p className="text-2xl font-bold text-gray-900">{summary.plus_ones_added}</p>
              <p className="text-gray-500">Guests added</p>
            </div>
          )}
        </div>
        <button onClick={() => { setSubmitted(false); window.location.reload() }} className="px-6 py-2.5 rounded-lg text-sm font-semibold text-white cursor-pointer transition-colors" style={{ backgroundColor: primaryColor, borderRadius: 'var(--radius-control)' }}>
          Edit your response
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="bg-white/10 backdrop-blur-sm rounded-2xl border border-white/10 p-8 text-center">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">You're Invited!</h1>
        <p className="text-lg text-gray-500">{party.name}</p>
      </div>

      {members.map(member => (
        <div key={member.id} className="bg-white/10 backdrop-blur-sm rounded-2xl border border-white/10 overflow-hidden">
          <div className="px-6 py-4 border-b border-white/10">
            <h3 className="text-lg font-semibold text-gray-900">
              {getMemberName(member)}
              {member.is_lead_booker && <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded-full bg-white/10 text-gray-500">Lead</span>}
              {member.is_plus_one && <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300">Guest</span>}
            </h3>
          </div>

          <div className="p-6 space-y-6">
            {member.events.map(event => {
              const entry = rsvpData[event.member_event_id]
              const locked = isDeadlinePassed(event.rsvp_deadline)
              const isAccepted = entry?.rsvp_status === 'accepted'

              return (
                <div key={event.member_event_id} className="space-y-3">
                  <div>
                    <h4 className="font-medium text-gray-900">{event.event_title}</h4>
                    {event.event_start && mounted && <p className="text-sm text-gray-500 mt-0.5">{formatDate(event.event_start)}</p>}
                  </div>

                  {locked ? (
                    <div className="inline-block px-3 py-1.5 text-sm font-medium text-gray-500 bg-white/10 rounded-lg">RSVP Closed</div>
                  ) : (
                    <div className="flex gap-2">
                      <button onClick={() => updateRsvp(event.member_event_id, 'accepted')}
                        className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-semibold transition-all cursor-pointer border-2 ${isAccepted ? 'text-white' : 'border-white/10 text-gray-800'}`}
                        style={isAccepted ? { backgroundColor: primaryColor, borderColor: primaryColor } : {}}>
                        Attending
                      </button>
                      <button onClick={() => updateRsvp(event.member_event_id, 'declined')}
                        className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-semibold transition-all cursor-pointer border-2 ${entry?.rsvp_status === 'declined' ? 'text-white' : 'border-white/10 text-gray-800'}`}
                        style={entry?.rsvp_status === 'declined' ? { backgroundColor: '#ef4444', borderColor: '#ef4444' } : {}}>
                        Not Attending
                      </button>
                    </div>
                  )}

                  {isAccepted && !locked && event.questions.length > 0 && (
                    <div className="space-y-3 pl-4 border-l-2" style={{ borderColor: `${primaryColor}40` }}>
                      {event.questions.map(q => (
                        <div key={q.id}>
                          <label className="block text-sm font-medium text-gray-800 mb-1">
                            {q.question_text}{q.is_required && <span className="text-red-500 ml-0.5">*</span>}
                          </label>
                          {q.question_type === 'select' && q.options && (
                            <select value={(entry?.answers[q.id] as string) || ''} onChange={e => updateAnswer(event.member_event_id, q.id, e.target.value)}
                              className="w-full px-3 py-2 text-sm border border-white/10 rounded-lg bg-white/10 text-gray-900 focus:outline-none focus:ring-2">
                              <option value="">Select...</option>
                              {q.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                            </select>
                          )}
                          {q.question_type === 'multi_select' && q.options && (
                            <div className="space-y-1.5">
                              {q.options.map(opt => {
                                const sel = Array.isArray(entry?.answers[q.id]) ? (entry.answers[q.id] as string[]).includes(opt) : false
                                return (
                                  <label key={opt} className="flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
                                    <input type="checkbox" checked={sel} onChange={() => {
                                      const cur = Array.isArray(entry?.answers[q.id]) ? [...(entry.answers[q.id] as string[])] : []
                                      updateAnswer(event.member_event_id, q.id, sel ? cur.filter(x => x !== opt) : [...cur, opt])
                                    }} className="rounded" />{opt}
                                  </label>
                                )
                              })}
                            </div>
                          )}
                          {q.question_type === 'text' && (
                            <textarea value={(entry?.answers[q.id] as string) || ''} onChange={e => updateAnswer(event.member_event_id, q.id, e.target.value)}
                              rows={2} className="w-full px-3 py-2 text-sm border border-white/10 rounded-lg bg-white/10 text-gray-900 focus:outline-none focus:ring-2 resize-y" />
                          )}
                          {q.question_type === 'yes_no' && (
                            <div className="flex gap-2">
                              {['Yes', 'No'].map(val => (
                                <button key={val} onClick={() => updateAnswer(event.member_event_id, q.id, val === 'Yes')}
                                  className={`px-4 py-1.5 text-sm rounded-lg border-2 font-medium cursor-pointer transition-colors ${entry?.answers[q.id] === (val === 'Yes') ? 'text-white' : 'border-white/10 text-gray-800'}`}
                                  style={entry?.answers[q.id] === (val === 'Yes') ? { backgroundColor: primaryColor, borderColor: primaryColor } : {}}>
                                  {val}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {(remainingPlusOnes > 0 || plusOnes.length > 0) && (
        <div className="bg-white/10 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Additional Guests</h3>
          {plusOnes.map((po, i) => (
            <div key={i} className="mb-4 p-4 bg-white/5 rounded-lg space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-gray-800">Guest {i + 1}</span>
                <button onClick={() => removePlusOne(i)} className="text-sm text-red-500 hover:text-red-700 cursor-pointer">Remove</button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input type="text" placeholder="First name" value={po.first_name} onChange={e => updatePlusOne(i, 'first_name', e.target.value)}
                  className="px-3 py-2 text-sm border border-white/10 rounded-lg bg-white/10 text-gray-900" />
                <input type="text" placeholder="Last name" value={po.last_name} onChange={e => updatePlusOne(i, 'last_name', e.target.value)}
                  className="px-3 py-2 text-sm border border-white/10 rounded-lg bg-white/10 text-gray-900" />
              </div>
              {allEvents.length > 1 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-gray-500">Attending:</label>
                  {allEvents.map(ev => (
                    <label key={ev.event_id} className="flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
                      <input type="checkbox" checked={po.event_ids.includes(ev.event_id)}
                        onChange={() => updatePlusOne(i, 'event_ids', po.event_ids.includes(ev.event_id) ? po.event_ids.filter(id => id !== ev.event_id) : [...po.event_ids, ev.event_id])}
                        className="rounded" />{ev.event_title}
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
          {remainingPlusOnes > 0 && (
            <button onClick={addPlusOne} className="text-sm font-medium hover:underline cursor-pointer" style={{ color: primaryColor }}>
              + Add a guest ({remainingPlusOnes} remaining)
            </button>
          )}
        </div>
      )}

      {error && <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-300">{error}</div>}

      {(() => {
        const requiredIds = members.flatMap(m =>
          m.events
            .filter(e => !isDeadlinePassed(e.rsvp_deadline))
            .map(e => e.member_event_id),
        )
        const pendingCount = requiredIds.filter(id => {
          const s = rsvpData[id]?.rsvp_status
          return s !== 'accepted' && s !== 'declined'
        }).length
        const allResponded = requiredIds.length > 0 && pendingCount === 0
        const disabled = submitting || !allResponded
        return (
          <>
            {!allResponded && requiredIds.length > 0 && (
              <p className="text-sm text-center text-gray-500">
                {pendingCount === 1
                  ? '1 response remaining before you can confirm'
                  : `${pendingCount} responses remaining before you can confirm`}
              </p>
            )}
            <button onClick={handleSubmit} disabled={disabled}
              className="w-full py-4 rounded-xl text-white font-semibold text-lg shadow-lg hover:shadow-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              style={{ backgroundColor: primaryColor }}>
              {submitting ? 'Submitting...' : 'Confirm RSVP'}
            </button>
          </>
        )
      })()}

      <p className="text-center text-xs text-gray-500">Powered by {brandName}</p>
    </div>
  )
}
