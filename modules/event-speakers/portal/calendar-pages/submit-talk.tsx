// @ts-nocheck — portal deps are resolved at build time via webpack alias
//
// Calendar submit-talk page content. Imported by the calendars module's
// portal/pages/[slug]/submit-talk.tsx which owns the route registration
// under /calendars/[slug]/submit-talk.
//
// Supports both anonymous and signed-in flows:
//   - Signed-in: pre-fills speaker fields from people record, shows existing
//     talks with edit/delete, allows additional submissions.
//   - Anonymous: plain form, edit token emailed on success.

'use client'

import { useEffect, useRef, useState } from 'react'
import { getSupabaseClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/useAuth'
import { PortalButton } from '@/components/ui/PortalButton'

interface Props {
  calendar: {
    id: string
    name: string
    slug: string | null
    calendar_id: string
  }
  /** Brand primary colour for the submit button glow + fill. */
  primaryColor?: string
}

type Status = 'idle' | 'submitting' | 'success' | 'error'

interface ExistingTalk {
  id: string
  title: string
  status: string
  edit_token: string | null
}

interface UserProfile {
  email: string
  first_name: string
  last_name: string
  company: string | null
  job_title: string | null
  linkedin_url: string | null
}

export function SubmitTalkForm({ calendar, primaryColor }: Props) {
  const { session, isLoading: authLoading } = useAuth()

  // Speaker fields
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [title, setTitle] = useState('')
  const [company, setCompany] = useState('')
  const [bio, setBio] = useState('')
  const [linkedinUrl, setLinkedinUrl] = useState('')

  // Talk fields
  const [talkTitle, setTalkTitle] = useState('')
  const [synopsis, setSynopsis] = useState('')
  const [duration, setDuration] = useState('30')
  const [topicsStr, setTopicsStr] = useState('')
  const [availableFrom, setAvailableFrom] = useState('')
  const [availableUntil, setAvailableUntil] = useState('')

  // State
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  // Signed-in user state
  const [existingTalks, setExistingTalks] = useState<ExistingTalk[]>([])
  const [isCheckingProfile, setIsCheckingProfile] = useState(false)
  const [profileLoaded, setProfileLoaded] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletingTalkId, setDeletingTalkId] = useState<string | null>(null)
  const hasCheckedRef = useRef(false)

  // Load signed-in user's profile and existing calendar talks
  useEffect(() => {
    async function loadProfile() {
      if (hasCheckedRef.current || authLoading || !session?.user?.id) return
      hasCheckedRef.current = true
      setIsCheckingProfile(true)

      try {
        const supabase = getSupabaseClient()

        // Get person record linked to auth user
        const { data: person } = await supabase
          .from('people')
          .select('id, email, attributes')
          .eq('auth_user_id', session.user.id)
          .maybeSingle()

        if (person) {
          const attrs = (person.attributes as Record<string, string>) || {}
          // Pre-fill speaker fields
          const firstName = attrs.first_name || ''
          const lastName = attrs.last_name || ''
          setName([firstName, lastName].filter(Boolean).join(' '))
          setEmail(person.email || '')
          setCompany(attrs.company || '')
          setTitle(attrs.job_title || '')
          setLinkedinUrl(attrs.linkedin_url || '')
          setBio(attrs.bio || '')

          // Find existing calendar talks by this person's email
          const { data: talks } = await supabase
            .from('events_talks')
            .select('id, title, status, edit_token')
            .eq('calendar_id', calendar.id)
            .eq('submitter_email', person.email.toLowerCase())
            .order('created_at', { ascending: false })

          if (talks && talks.length > 0) {
            setExistingTalks(talks)
          }
        }

        setProfileLoaded(true)
      } catch (err) {
        console.error('[submit-talk] Error loading profile:', err)
      } finally {
        setIsCheckingProfile(false)
      }
    }

    loadProfile()
  }, [session, authLoading, calendar.id])

  const handleDeleteTalk = async (talkId: string) => {
    setDeletingTalkId(talkId)
    try {
      const supabase = getSupabaseClient()
      const { error } = await supabase
        .from('events_talks')
        .delete()
        .eq('id', talkId)

      if (error) throw error
      setExistingTalks(prev => prev.filter(t => t.id !== talkId))
      setConfirmDeleteId(null)
    } catch (err) {
      console.error('[submit-talk] Delete error:', err)
      alert('Failed to delete submission. Please try again.')
    } finally {
      setDeletingTalkId(null)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus('submitting')
    setErrorMessage('')

    try {
      const res = await fetch('/api/calendar-talks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendar_slug: calendar.slug || calendar.calendar_id,
          speaker: {
            name,
            email,
            title,
            company,
            bio,
            linkedin_url: linkedinUrl,
          },
          talk: {
            title: talkTitle,
            synopsis,
            duration_minutes: parseInt(duration, 10),
            topics: topicsStr.split(',').map((t) => t.trim()).filter(Boolean),
            available_from: availableFrom || null,
            available_until: availableUntil || null,
          },
        }),
      })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErrorMessage(body?.error?.message || 'Submission failed')
        setStatus('error')
        return
      }

      // If signed in, add to existing talks list so they see it immediately
      if (body?.data?.talk_id) {
        setExistingTalks(prev => [{
          id: body.data.talk_id,
          title: talkTitle,
          status: 'pending',
          edit_token: body.data.edit_token || null,
        }, ...prev])
      }

      setStatus('success')
    } catch (err) {
      setErrorMessage('Network error. Please try again.')
      setStatus('error')
    }
  }

  function resetForm() {
    setTalkTitle('')
    setSynopsis('')
    setDuration('30')
    setTopicsStr('')
    setAvailableFrom('')
    setAvailableUntil('')
    setStatus('idle')
    setErrorMessage('')
  }

  // Loading while checking auth
  if (authLoading || (session && isCheckingProfile)) {
    return (
      <div className="bg-white/5 border border-white/15 rounded-2xl p-8 text-center">
        <div className="w-8 h-8 mx-auto mb-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        <p className="text-white/60 text-sm">Checking for existing submissions…</p>
      </div>
    )
  }

  // Success state
  if (status === 'success') {
    return (
      <div className="space-y-6">
        {/* Existing talks (if signed in and have any) */}
        {existingTalks.length > 0 && (
          <ExistingTalksPanel
            talks={existingTalks}
            calendarName={calendar.name}
            calendarSlug={calendar.slug || calendar.calendar_id}
            confirmDeleteId={confirmDeleteId}
            deletingTalkId={deletingTalkId}
            onDelete={handleDeleteTalk}
            onConfirmDelete={setConfirmDeleteId}
          />
        )}

        <div className="bg-white/5 border border-white/15 rounded-2xl p-8 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/20 flex items-center justify-center">
            <svg className="w-8 h-8 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-white text-2xl font-bold">Submission received</h2>
          <p className="text-white/70 mt-3 max-w-md mx-auto">
            Thanks {name}! The {calendar.name} organisers will review your submission and reach out.
            {!session && " We've sent you a confirmation email with a link to edit or withdraw."}
          </p>
          <button
            onClick={resetForm}
            className="mt-6 px-6 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors text-sm"
          >
            Submit another talk
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Existing talks panel (signed-in users) */}
      {existingTalks.length > 0 && (
        <ExistingTalksPanel
          talks={existingTalks}
          calendarName={calendar.name}
          calendarSlug={calendar.slug || calendar.calendar_id}
          confirmDeleteId={confirmDeleteId}
          deletingTalkId={deletingTalkId}
          onDelete={handleDeleteTalk}
          onConfirmDelete={setConfirmDeleteId}
        />
      )}

      {/* Submission form */}
      <form
        onSubmit={handleSubmit}
        // suppressHydrationWarning: password manager extensions inject
        // decorative DOM nodes into form inputs after hydration; scoped here.
        suppressHydrationWarning
        className="p-6 sm:p-8 w-full space-y-8"
        style={{
          borderRadius: 'var(--radius-control, 12px)',
          backgroundColor: `rgba(var(--panel-tint, 0,0,0), var(--glass-opacity, 0.05))`,
          backdropFilter: `blur(var(--glass-blur, 4px))`,
          WebkitBackdropFilter: `blur(var(--glass-blur, 4px))`,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: `rgba(var(--panel-tint, 0,0,0), var(--glass-border-opacity, 0.1))`,
        }}
      >
        {existingTalks.length > 0 && (
          <p className="text-white/60 text-sm">
            Want to submit another talk? Fill in the details below.
          </p>
        )}

        {/* Speaker section */}
        <section className="space-y-4">
          <h3 className="text-white text-lg font-semibold">About you</h3>
          {profileLoaded && (
            <p className="text-white/50 text-xs -mt-2">Pre-filled from your profile</p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-white/80 text-sm mb-1">Full name *</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white"
              />
            </div>
            <div>
              <label className="block text-white/80 text-sm mb-1">Email *</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={!!session}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white disabled:opacity-60"
              />
            </div>
            <div>
              <label className="block text-white/80 text-sm mb-1">Title / role</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white"
              />
            </div>
            <div>
              <label className="block text-white/80 text-sm mb-1">Company</label>
              <input
                type="text"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-white/80 text-sm mb-1">LinkedIn URL</label>
              <input
                type="url"
                value={linkedinUrl}
                onChange={(e) => setLinkedinUrl(e.target.value)}
                placeholder="https://linkedin.com/in/..."
                className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-white/80 text-sm mb-1">Short bio</label>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={3}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white"
              />
            </div>
          </div>
        </section>

        {/* Talk section */}
        <section className="space-y-4">
          <h3 className="text-white text-lg font-semibold">Your talk</h3>
          <div>
            <label className="block text-white/80 text-sm mb-1">Talk title *</label>
            <input
              type="text"
              required
              value={talkTitle}
              onChange={(e) => setTalkTitle(e.target.value)}
              className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-white/80 text-sm mb-1">Synopsis (100–2000 chars) *</label>
            <textarea
              required
              minLength={100}
              maxLength={2000}
              value={synopsis}
              onChange={(e) => setSynopsis(e.target.value)}
              rows={6}
              className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white"
            />
            <div className="text-xs text-white/40 mt-1">{synopsis.length} / 2000</div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-white/80 text-sm mb-1">Duration</label>
              <select
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white"
              >
                <option value="15">15 min</option>
                <option value="30">30 min</option>
                <option value="45">45 min</option>
                <option value="60">60 min</option>
              </select>
            </div>
            <div>
              <label className="block text-white/80 text-sm mb-1">Available from</label>
              <input
                type="date"
                value={availableFrom}
                onChange={(e) => setAvailableFrom(e.target.value)}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white"
              />
            </div>
            <div>
              <label className="block text-white/80 text-sm mb-1">Available until</label>
              <input
                type="date"
                value={availableUntil}
                onChange={(e) => setAvailableUntil(e.target.value)}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white"
              />
            </div>
          </div>
          <div>
            <label className="block text-white/80 text-sm mb-1">Topics (comma-separated)</label>
            <input
              type="text"
              value={topicsStr}
              onChange={(e) => setTopicsStr(e.target.value)}
              placeholder="distributed-systems, engineering, leadership"
              className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white"
            />
          </div>
        </section>

        {status === 'error' && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-200 text-sm">
            {errorMessage}
          </div>
        )}

        <PortalButton
          variant="primary"
          glow
          type="submit"
          primaryColor={primaryColor}
          disabled={status === 'submitting'}
          isLoading={status === 'submitting'}
          className="w-full"
        >
          {status === 'submitting' ? 'Submitting…' : 'Submit talk'}
        </PortalButton>

        <p className="text-white/40 text-xs text-center">
          {session
            ? 'You can manage your submissions from this page any time.'
            : "We'll email you a link to edit or withdraw your submission any time."}
        </p>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Existing Talks Panel (reusable sub-component)
// ---------------------------------------------------------------------------

function ExistingTalksPanel({
  talks,
  calendarName,
  calendarSlug,
  confirmDeleteId,
  deletingTalkId,
  onDelete,
  onConfirmDelete,
}: {
  talks: ExistingTalk[]
  calendarName: string
  calendarSlug: string
  confirmDeleteId: string | null
  deletingTalkId: string | null
  onDelete: (id: string) => void
  onConfirmDelete: (id: string | null) => void
}) {
  return (
    <div className="bg-white/5 border border-white/15 rounded-2xl p-6 sm:p-8">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center">
          <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">
            Your submission{talks.length > 1 ? 's' : ''}
          </h2>
          <p className="text-white/60 text-sm">
            {talks.length} talk{talks.length > 1 ? 's' : ''} submitted to {calendarName}
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {talks.map((talk) => (
          <div
            key={talk.id}
            className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 rounded-xl bg-white/5 border border-white/10"
          >
            <div className="flex-1 min-w-0">
              <p className="text-white font-medium truncate">&ldquo;{talk.title}&rdquo;</p>
              <p className="text-white/60 text-sm">
                Status: <span className="capitalize font-medium">{talk.status}</span>
              </p>
            </div>
            <div className="flex items-center gap-2">
              {confirmDeleteId === talk.id ? (
                <>
                  <span className="text-white/60 text-sm mr-1">Delete?</span>
                  <button
                    onClick={() => onDelete(talk.id)}
                    disabled={deletingTalkId === talk.id}
                    className="cursor-pointer px-3 py-1.5 text-sm font-medium rounded-lg bg-red-500/80 hover:bg-red-500 text-white transition-colors disabled:opacity-50"
                  >
                    {deletingTalkId === talk.id ? 'Deleting…' : 'Confirm'}
                  </button>
                  <button
                    onClick={() => onConfirmDelete(null)}
                    disabled={deletingTalkId === talk.id}
                    className="cursor-pointer px-3 py-1.5 text-sm font-medium rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  {talk.edit_token && (
                    <a
                      href={`/calendars/${calendarSlug}/submit-talk?edit=${talk.edit_token}`}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                      Edit
                    </a>
                  )}
                  <button
                    onClick={() => onConfirmDelete(talk.id)}
                    className="cursor-pointer p-1.5 rounded-lg bg-white/5 hover:bg-red-500/20 text-white/60 hover:text-red-400 transition-colors"
                    title="Delete submission"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
