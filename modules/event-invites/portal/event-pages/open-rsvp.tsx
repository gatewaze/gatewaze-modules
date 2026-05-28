'use client'

// @ts-nocheck — portal deps are resolved at build time via webpack alias

import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import DOMPurify from 'isomorphic-dompurify'

/** Normalize a question option (string | { label, description? }) for rendering. */
interface NormalizedOption { label: string; description?: string }
function normalizeOption(raw: unknown): NormalizedOption {
  if (typeof raw === 'string') return { label: raw }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    return {
      label: typeof r.label === 'string' ? r.label : '',
      description: typeof r.description === 'string' && r.description.trim() ? r.description : undefined,
    }
  }
  return { label: '' }
}
function normalizeOptions(options: unknown): NormalizedOption[] {
  if (!Array.isArray(options)) return []
  return options.map(normalizeOption).filter(o => o.label !== '')
}

function safeHtml(html: string | null | undefined): string {
  if (!html) return ''
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'span'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  })
}

interface SubEvent {
  id: string
  name: string
  slug?: string | null
  description: string | null
  starts_at: string | null
  ends_at: string | null
  rsvp_deadline: string | null
  linked_rsvp?: boolean
}

interface Question {
  id: string
  sub_event_id: string | null
  question_text: string
  question_type: 'select' | 'multi_select' | 'text' | 'yes_no'
  options: Array<string | { label: string; description?: string }> | null
  is_required: boolean
  applies_to: 'all' | 'accepted_only'
}

interface LoadResponse {
  link: {
    id: string
    short_code: string
    label: string | null
    sub_event_id: string | null
    max_members_per_party: number
  }
  event: {
    id: string
    title: string
    starts_at: string | null
    ends_at: string | null
    location: string | null
    rsvp_deadline: string | null
  }
  sub_events: SubEvent[]
  questions: Question[]
}

interface MemberDraft {
  first_name: string
  last_name: string
  email: string
  phone: string
  rsvps: Record<string, string>
  answers: Record<string, unknown>
}

interface Props {
  eventIdentifier: string
  primaryColor: string
  brandName: string
  darkMode?: boolean
}

function emptyMember(): MemberDraft {
  return { first_name: '', last_name: '', email: '', phone: '', rsvps: {}, answers: {} }
}

function formatWhen(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function OpenRsvpEventPage({ primaryColor }: Props) {
  const searchParams = useSearchParams()
  const [code, setCode] = useState<string | null>(null)
  const [data, setData] = useState<LoadResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [noCode, setNoCode] = useState(false)

  const [members, setMembers] = useState<MemberDraft[]>([emptyMember()])

  // When sub-events are linked, accepting one auto-accepts the rest
  // (use case: a wedding's day ceremony and evening reception, where
  // attending the day implies attending the evening). We hide the
  // follow-on linked sub-events from the UI entirely and merge their
  // questions into the first linked one.
  const linkedSubEvents = data?.sub_events.filter(se => se.linked_rsvp) ?? []
  const firstLinkedId = linkedSubEvents[0]?.id ?? null
  const allSubEventsLinked = !!data
    && data.sub_events.length > 0
    && data.sub_events.every(se => se.linked_rsvp)

  // True when the link only covers one effective decision — no sub-events,
  // one sub-event, or all sub-events are linked together. In that case we
  // skip the yes/no UI entirely: guests only land here because they can
  // attend, so we auto-accept for them.
  const isSingleEvent = !!data && (data.sub_events.length <= 1 || allSubEventsLinked)
  const singleEventId = isSingleEvent
    ? (allSubEventsLinked ? firstLinkedId : (data?.sub_events[0]?.id ?? ''))
    : null

  // Main event RSVP deadline — admins set this to stop accepting new
  // responses after a cutoff. The API also enforces this; the UI blocks
  // submission early so guests get a clear message instead of a 403.
  const rsvpDeadline = data?.event.rsvp_deadline ?? null
  const rsvpClosed = !!rsvpDeadline && new Date(rsvpDeadline) < new Date()

  // Read the open link code from ?o= query param; persist to localStorage so
  // page reloads don't lose it (mirrors the existing rsvp flow's invite_short_code).
  useEffect(() => {
    const fromQuery = searchParams.get('o')
    if (fromQuery) {
      localStorage.setItem('open_rsvp_code', fromQuery)
      setCode(fromQuery)
      return
    }
    const fromStorage = typeof window !== 'undefined' ? localStorage.getItem('open_rsvp_code') : null
    if (fromStorage) {
      setCode(fromStorage)
      return
    }
    setNoCode(true)
    setLoading(false)
  }, [searchParams])

  const load = useCallback(async () => {
    if (!code) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/open-rsvp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'load', code }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body.message || 'Failed to load invitation.')
        return
      }
      setData(body as LoadResponse)
    } catch {
      setError('Failed to load invitation.')
    } finally {
      setLoading(false)
    }
  }, [code])

  useEffect(() => {
    if (code) load()
  }, [code, load])

  // Single-event links auto-accept every member. Runs after data loads and
  // whenever a new member is added (addMember pre-populates the rsvp too,
  // but this guards against any other path that might miss it).
  //
  // For the "all sub-events linked" case we set accepted on *every*
  // linked sub-event so the backend gets a row for each — even though
  // only one panel is visible to the user.
  useEffect(() => {
    if (singleEventId === null) return
    const propagateIds = allSubEventsLinked
      ? linkedSubEvents.map(se => se.id)
      : [singleEventId]
    setMembers(prev => {
      let changed = false
      const next = prev.map(m => {
        let rsvps = m.rsvps
        for (const id of propagateIds) {
          if (rsvps[id] !== 'accepted') {
            rsvps = { ...rsvps, [id]: 'accepted' }
            changed = true
          }
        }
        return rsvps === m.rsvps ? m : { ...m, rsvps }
      })
      return changed ? next : prev
    })
  }, [singleEventId, members.length, allSubEventsLinked, linkedSubEvents])

  const updateMember = (idx: number, patch: Partial<MemberDraft>) => {
    setMembers(prev => prev.map((m, i) => (i === idx ? { ...m, ...patch } : m)))
  }

  const setMemberRsvp = (idx: number, subEventId: string, status: string) => {
    // When toggling a linked sub-event, propagate the same status to every
    // other linked sub-event for this member. Hitting "Yes" on the day
    // ceremony automatically sets "Yes" on the evening reception, etc.
    const clicked = data?.sub_events.find(s => s.id === subEventId)
    const propagateIds: string[] = clicked?.linked_rsvp
      ? (data?.sub_events.filter(s => s.linked_rsvp).map(s => s.id) ?? [subEventId])
      : [subEventId]

    setMembers(prev =>
      prev.map((m, i) => {
        if (i !== idx) return m
        let rsvps = m.rsvps
        for (const id of propagateIds) {
          rsvps = { ...rsvps, [id]: status }
        }
        return { ...m, rsvps }
      }),
    )
  }

  const setMemberAnswer = (idx: number, subEventId: string, questionId: string, value: unknown) => {
    const key = `${subEventId}:${questionId}`
    setMembers(prev =>
      prev.map((m, i) => (i === idx ? { ...m, answers: { ...m.answers, [key]: value } } : m)),
    )
  }

  const addMember = () => {
    const fresh = emptyMember()
    // Pre-accept on single-event links so the new row is immediately valid.
    // For the "all sub-events linked" case we set every linked sub-event
    // so the submission writes a row for each.
    if (singleEventId !== null) {
      const ids = allSubEventsLinked
        ? linkedSubEvents.map(se => se.id)
        : [singleEventId]
      for (const id of ids) fresh.rsvps[id] = 'accepted'
    }
    setMembers(prev => [...prev, fresh])
  }
  const removeMember = (idx: number) => setMembers(prev => prev.filter((_, i) => i !== idx))

  const questionsFor = (subEventId: string | null): Question[] => {
    if (!data) return []
    return data.questions
      .filter(q => q.sub_event_id === subEventId || q.sub_event_id === null)
  }

  const handleSubmit = async () => {
    if (!data || !code) return
    setError(null)

    // Hard-stop when the RSVP window has already closed. Matches the
    // server-side check so guests don't even attempt a submit that
    // would just come back as a 403.
    if (rsvpClosed) {
      setError('The RSVP deadline for this event has passed.')
      return
    }

    // Lead booker (member 0) must have a valid email so we can reach them
    const leadEmail = members[0]?.email.trim() || ''
    if (!leadEmail) {
      setError('Your email address is required')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(leadEmail)) {
      setError('Please enter a valid email address')
      return
    }

    // Validate
    for (let i = 0; i < members.length; i++) {
      const m = members[i]
      if (!m.first_name.trim() && !m.last_name.trim()) {
        setError(`Member ${i + 1} needs a name`)
        return
      }
      const rsvpEntries = Object.entries(m.rsvps).filter(([, status]) => !!status)
      if (rsvpEntries.length === 0) {
        setError(`${m.first_name || 'Member ' + (i + 1)} hasn't RSVP'd to any event`)
        return
      }
      for (const [subEventId, status] of rsvpEntries) {
        if (status !== 'accepted') continue
        const qs = questionsFor(subEventId || null)
        for (const q of qs) {
          if (!q.is_required) continue
          const ans = m.answers[`${subEventId}:${q.id}`]
          const empty =
            ans === undefined ||
            ans === null ||
            ans === '' ||
            (Array.isArray(ans) && ans.length === 0)
          if (empty) {
            // Strip HTML tags for the error message
            const plainQuestion = q.question_text.replace(/<[^>]*>/g, '').trim()
            setError(`"${plainQuestion}" is required for ${m.first_name || 'a member'}`)
            return
          }
        }
      }
    }

    // Auto-derive a party name from the member list so guests don't have to
    // type one. Single member → "First Last"; multiple → first names joined.
    const derivedPartyName = (() => {
      const named = members
        .map(m => ({
          first: m.first_name.trim(),
          last: m.last_name.trim(),
        }))
        .filter(m => m.first || m.last)
      if (named.length === 0) return undefined
      if (named.length === 1) {
        return [named[0].first, named[0].last].filter(Boolean).join(' ') || undefined
      }
      const firsts = named.map(m => m.first || m.last)
      if (firsts.length === 2) return `${firsts[0]} & ${firsts[1]}`
      return `${firsts.slice(0, -1).join(', ')} & ${firsts[firsts.length - 1]}`
    })()

    setSubmitting(true)
    try {
      const payloadMembers = members.map(m => {
        const rsvps: Array<{ sub_event_id: string | null; status: string }> = []
        const answers: Array<{ sub_event_id: string | null; question_id: string; answer: unknown }> = []
        for (const [subEventId, status] of Object.entries(m.rsvps)) {
          if (!status) continue
          rsvps.push({ sub_event_id: subEventId || null, status })
          const qs = questionsFor(subEventId || null)
          for (const q of qs) {
            const key = `${subEventId}:${q.id}`
            if (m.answers[key] !== undefined && m.answers[key] !== '' && m.answers[key] !== null) {
              answers.push({
                sub_event_id: subEventId || null,
                question_id: q.id,
                answer: m.answers[key],
              })
            }
          }
        }
        return {
          first_name: m.first_name.trim(),
          last_name: m.last_name.trim(),
          email: m.email.trim() || undefined,
          phone: m.phone.trim() || undefined,
          rsvps,
          answers,
        }
      })

      const res = await fetch('/api/open-rsvp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'submit',
          code,
          party_name: derivedPartyName,
          members: payloadMembers,
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body.message || 'Failed to submit.')
        return
      }
      // Clear the open-link code from storage so a later visit without ?o=
      // doesn't re-show the form they just submitted
      if (typeof window !== 'undefined') localStorage.removeItem('open_rsvp_code')
      setSubmitted(true)
    } catch {
      setError('Failed to submit.')
    } finally {
      setSubmitting(false)
    }
  }

  if (noCode) {
    return (
      <div className="py-12 text-center text-gray-500">
        <h1 className="text-xl font-semibold mb-2 text-gray-900">No invitation link</h1>
        <p>Open this page using the shareable link you were given, e.g. <code>/o/abc123</code>.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="py-12 text-center text-gray-500">Loading invitation...</div>
    )
  }

  if (error && !data) {
    return (
      <div className="py-12 text-center">
        <h1 className="text-xl font-semibold mb-2 text-gray-900">Can&apos;t load this invitation</h1>
        <p className="text-gray-500">{error}</p>
      </div>
    )
  }

  if (!data) return null

  if (submitted) {
    return (
      <div className="space-y-8">
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">RSVP</h1>
        <div className="py-8 text-center">
          <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6" style={{ backgroundColor: `${primaryColor}30`, animation: 'rsvp-pop 0.4s cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <svg className="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 13l4 4L19 7" style={{ strokeDasharray: 24, strokeDashoffset: 24, animation: 'rsvp-draw 0.5s 0.3s ease forwards' }} />
            </svg>
          </div>
          <style>{`
            @keyframes rsvp-draw { to { stroke-dashoffset: 0; } }
            @keyframes rsvp-pop { 0% { transform: scale(0); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
          `}</style>
          <h2 className="text-xl font-semibold mb-2 text-gray-900">Thank you!</h2>
          <p className="text-gray-500">Your RSVP has been recorded.</p>
        </div>
      </div>
    )
  }

  const inputClass = 'w-full px-3 py-2 text-sm rounded-md focus:outline-none bg-white/10 border border-white/10 text-gray-900'

  return (
    <div className="space-y-8">
      {/* Event header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">RSVP</h1>
        {data.event.starts_at && (
          <p className="text-sm mt-2 text-gray-500">{formatWhen(data.event.starts_at)}</p>
        )}
        {rsvpDeadline && (
          <p className="text-sm mt-1 text-gray-500">
            {rsvpClosed ? 'RSVP closed on ' : 'Please RSVP by '}
            <span className="font-medium text-gray-900">{formatWhen(rsvpDeadline)}</span>
          </p>
        )}
      </div>

      {rsvpClosed && (
        <div className="rounded-md p-4 text-sm bg-white/5 border border-white/10 text-gray-900">
          The RSVP deadline for this event has passed and responses are no longer being accepted.
        </div>
      )}

      {/* Members — skip the whole form once RSVP is closed so guests can't
          fill out fields for a submission that would just 403. */}
      {!rsvpClosed && members.map((member, idx) => (
        <div key={idx} className="rounded-lg p-4 space-y-4 bg-white/5 border border-white/10">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900">
              {idx === 0 ? 'You' : `Party member ${idx + 1}`}
            </h2>
            {members.length > 1 && (
              <button
                type="button"
                onClick={() => removeMember(idx)}
                className="text-sm hover:underline"
                style={{ color: '#ef4444' }}
              >
                Remove
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1 text-gray-500">First name</label>
              <input
                type="text"
                value={member.first_name}
                onChange={e => updateMember(idx, { first_name: e.target.value })}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1 text-gray-500">Last name</label>
              <input
                type="text"
                value={member.last_name}
                onChange={e => updateMember(idx, { last_name: e.target.value })}
                className={inputClass}
              />
            </div>
            {idx === 0 && (
              <>
                <div>
                  <label className="block text-xs font-medium mb-1 text-gray-500">
                    Email <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="email"
                    required
                    value={member.email}
                    onChange={e => updateMember(idx, { email: e.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1 text-gray-500">
                    Phone <span className="font-normal text-gray-500">(optional)</span>
                  </label>
                  <input
                    type="tel"
                    value={member.phone}
                    onChange={e => updateMember(idx, { phone: e.target.value })}
                    className={inputClass}
                  />
                </div>
              </>
            )}
          </div>

          {/* RSVP per sub-event */}
          <div className="space-y-3">
            {(data.sub_events.length === 0
              ? [{ id: '', name: data.event.title, description: null, starts_at: data.event.starts_at, ends_at: null, rsvp_deadline: null } as SubEvent]
              : data.sub_events
            ).map(se => {
              // For linked sub-events we only render the first one's panel;
              // the rest are silently auto-accepted via the effect/setter
              // above. Their questions get merged into the first's accepted
              // panel below.
              if (se.linked_rsvp && se.id !== firstLinkedId) return null

              const currentStatus = member.rsvps[se.id] || ''
              // If this is the first linked sub-event, any accepted-only
              // questions from the other linked ones show up alongside
              // our own. Each question remembers its real sub-event id so
              // the answer is stored under the correct sub_event on submit.
              const ownQuestions = currentStatus === 'accepted'
                ? questionsFor(se.id || null).map(q => ({ q, seId: se.id }))
                : []
              const mergedLinkedQuestions =
                se.id === firstLinkedId && currentStatus === 'accepted'
                  ? linkedSubEvents
                      .filter(linked => linked.id !== se.id)
                      .flatMap(linked =>
                        questionsFor(linked.id).map(q => ({ q, seId: linked.id })),
                      )
                  : []
              const questionsToRender = [...ownQuestions, ...mergedLinkedQuestions]

              // Single-event link with no questions: skip the whole panel.
              // The visitor is already on the event's page — showing them
              // the event name/date again is redundant.
              if (isSingleEvent && questionsToRender.length === 0) return null
              return (
                <div key={se.id || 'event'} className="rounded-md p-3 border border-white/10">
                  {!isSingleEvent && (
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-900">{se.name}</p>
                        {se.starts_at && (
                          <p className="text-xs mt-0.5 text-gray-500">{formatWhen(se.starts_at)}</p>
                        )}
                        {se.description && (
                          <p className="text-xs mt-1 text-gray-500">{se.description}</p>
                        )}
                      </div>
                      <div className="flex gap-1 shrink-0">
                        {(['accepted', 'declined'] as const).map(status => {
                          const isSelected = currentStatus === status
                          return (
                            <button
                              key={status}
                              type="button"
                              onClick={() => setMemberRsvp(idx, se.id, status)}
                              className={`px-3 py-1.5 text-xs font-medium transition-all ${isSelected ? 'portal-primary-button text-white' : 'bg-white/10 text-gray-900 border border-white/10'}`}
                              style={
                                isSelected
                                  ? { '--button-bg': primaryColor, borderRadius: 'var(--radius-control)' } as React.CSSProperties
                                  : { borderRadius: 'var(--radius-control)' }
                              }
                            >
                              <span className="relative z-10">{status === 'accepted' ? 'Yes' : 'No'}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {questionsToRender.length > 0 && (
                    <div className={isSingleEvent ? 'space-y-3' : 'mt-3 pt-3 space-y-3 border-t border-white/10'}>
                      {questionsToRender.map(({ q, seId }) => {
                        // seId is the question's OWN sub-event — for
                        // merged-linked questions it differs from se.id.
                        // Answers are keyed by seId so the submit handler
                        // still writes each answer under the correct
                        // invite_party_member_events.sub_event_id row.
                        const ansKey = `${seId}:${q.id}`
                        const value = member.answers[ansKey]
                        return (
                          <div key={`${seId}:${q.id}`}>
                            <div className="text-xs font-medium mb-2 text-gray-900 [&_p]:m-0 [&_p+p]:mt-1">
                              <span dangerouslySetInnerHTML={{ __html: safeHtml(q.question_text) }} />
                              {q.is_required && <span className="ml-1 text-red-500">*</span>}
                            </div>
                            {q.question_type === 'select' && (
                              <div className="space-y-2">
                                {normalizeOptions(q.options).map(opt => {
                                  const sel = (value as string) === opt.label
                                  const inputId = `${idx}:${seId}:${q.id}:${opt.label}`
                                  return (
                                    <label
                                      key={opt.label}
                                      htmlFor={inputId}
                                      className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                                        sel ? 'bg-white/10' : 'border-white/10 hover:border-white/20 hover:bg-white/5'
                                      }`}
                                      style={sel ? { borderColor: primaryColor } : undefined}
                                    >
                                      <input
                                        id={inputId}
                                        type="radio"
                                        name={`${idx}:${seId}:${q.id}`}
                                        checked={sel}
                                        onChange={() => setMemberAnswer(idx, seId, q.id, opt.label)}
                                        className="mt-1 cursor-pointer"
                                        style={sel ? { accentColor: primaryColor } : undefined}
                                      />
                                      <div className="flex-1 min-w-0">
                                        <div className="text-sm font-semibold text-gray-900">{opt.label}</div>
                                        {opt.description && (
                                          <div
                                            className="text-xs text-gray-600 mt-1 [&_p]:m-0 [&_p+p]:mt-1 [&_a]:underline"
                                            dangerouslySetInnerHTML={{ __html: safeHtml(opt.description) }}
                                          />
                                        )}
                                      </div>
                                    </label>
                                  )
                                })}
                              </div>
                            )}
                            {q.question_type === 'multi_select' && (
                              <div className="space-y-2">
                                {normalizeOptions(q.options).map(opt => {
                                  const arr = Array.isArray(value) ? (value as string[]) : []
                                  const checked = arr.includes(opt.label)
                                  const inputId = `${idx}:${seId}:${q.id}:${opt.label}`
                                  return (
                                    <label
                                      key={opt.label}
                                      htmlFor={inputId}
                                      className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                                        checked ? 'bg-white/10' : 'border-white/10 hover:border-white/20 hover:bg-white/5'
                                      }`}
                                      style={checked ? { borderColor: primaryColor } : undefined}
                                    >
                                      <input
                                        id={inputId}
                                        type="checkbox"
                                        checked={checked}
                                        onChange={e => {
                                          const next = e.target.checked ? [...arr, opt.label] : arr.filter(x => x !== opt.label)
                                          setMemberAnswer(idx, seId, q.id, next)
                                        }}
                                        className="mt-1 cursor-pointer"
                                        style={checked ? { accentColor: primaryColor } : undefined}
                                      />
                                      <div className="flex-1 min-w-0">
                                        <div className="text-sm font-semibold text-gray-900">{opt.label}</div>
                                        {opt.description && (
                                          <div
                                            className="text-xs text-gray-600 mt-1 [&_p]:m-0 [&_p+p]:mt-1 [&_a]:underline"
                                            dangerouslySetInnerHTML={{ __html: safeHtml(opt.description) }}
                                          />
                                        )}
                                      </div>
                                    </label>
                                  )
                                })}
                              </div>
                            )}
                            {q.question_type === 'yes_no' && (
                              <div className="flex gap-2">
                                {['yes', 'no'].map(v => {
                                  const isSelected = value === v
                                  return (
                                    <button
                                      key={v}
                                      type="button"
                                      onClick={() => setMemberAnswer(idx, seId, q.id, v)}
                                      className={`px-3 py-1.5 text-sm transition-all ${isSelected ? 'portal-primary-button text-white' : 'bg-white/10 text-gray-900 border border-white/10'}`}
                                      style={
                                        isSelected
                                          ? { '--button-bg': primaryColor, borderRadius: 'var(--radius-control)' } as React.CSSProperties
                                          : { borderRadius: 'var(--radius-control)' }
                                      }
                                    >
                                      <span className="relative z-10">{v.charAt(0).toUpperCase() + v.slice(1)}</span>
                                    </button>
                                  )
                                })}
                              </div>
                            )}
                            {q.question_type === 'text' && (
                              <textarea
                                value={(value as string) || ''}
                                onChange={e => setMemberAnswer(idx, seId, q.id, e.target.value)}
                                rows={2}
                                className={inputClass + ' resize-y'}
                              />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {/* Add member */}
      {!rsvpClosed && members.length < data.link.max_members_per_party && (
        <button
          type="button"
          onClick={addMember}
          className="w-full py-2 text-sm font-medium rounded-md bg-transparent text-gray-900 border border-dashed border-white/10"
        >
          + Add another person
        </button>
      )}

      {error && (
        <div className="rounded-md p-3 text-sm" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
          {error}
        </div>
      )}

      {!rsvpClosed && (
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="w-full py-3 text-sm font-semibold text-white rounded-md disabled:opacity-60"
          style={{ backgroundColor: primaryColor }}
        >
          {submitting ? 'Submitting...' : 'Submit RSVP'}
        </button>
      )}
    </div>
  )
}
