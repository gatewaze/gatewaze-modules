'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useEventContext } from '@/components/event/EventContext'
import { GlowInput } from '@/components/ui/GlowInput'
import { PortalButton } from '@/components/ui/PortalButton'
import { useAuth } from '@/hooks/useAuth'
import { getSupabaseClient } from '@/lib/supabase/client'

interface Registrant {
  id: string
  email: string
  person_id: number
  first_name: string | null
  last_name: string | null
  company: string | null
  job_title: string | null
  status: string
  attributes: Record<string, unknown> | null
}

interface EditForm {
  first_name: string
  last_name: string
  company: string
  job_title: string
}

export default function KioskEventPage() {
  const { user, isLoading: authLoading } = useAuth()
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)

  useEffect(() => {
    if (authLoading || !user) {
      setIsAdmin(null)
      return
    }
    let cancelled = false
    const supabase = getSupabaseClient()
    supabase
      .from('admin_profiles')
      .select('id')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .in('role', ['admin', 'super_admin'])
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setIsAdmin(!!data)
      })
    return () => { cancelled = true }
  }, [user, authLoading])

  if (authLoading || isAdmin === null) {
    return <KioskShell><LoadingState /></KioskShell>
  }

  if (!user || !isAdmin) {
    return <KioskShell><AccessDenied /></KioskShell>
  }

  return <KioskShell><KioskContent /></KioskShell>
}

function KioskShell({ children }: { children: React.ReactNode }) {
  const { useDarkText, theme } = useEventContext()
  const textColor = useDarkText ? 'text-gray-900' : 'text-white'
  const mutedColor = useDarkText ? 'text-gray-600' : 'text-white/60'

  return (
    <div className="space-y-6">
      <div>
        <h2 className={`text-2xl font-bold ${textColor}`}>Kiosk Mode</h2>
        <p className={`text-sm mt-1 ${mutedColor}`}>
          Search for a registrant to update their information
        </p>
      </div>
      {children}
    </div>
  )
}

function LoadingState() {
  const { useDarkText } = useEventContext()
  const mutedColor = useDarkText ? 'text-gray-600' : 'text-white/60'
  return <p className={`text-sm ${mutedColor}`}>Loading...</p>
}

function AccessDenied() {
  const { useDarkText, theme } = useEventContext()
  const panelClasses = `${theme.panelBg} backdrop-blur-[10px] rounded-2xl shadow-2xl ${theme.panelBorder}`
  const mutedColor = useDarkText ? 'text-gray-600' : 'text-white/60'
  return (
    <div className={`${panelClasses} p-6 text-center`}>
      <p className={mutedColor}>Kiosk mode is only available to administrators.</p>
    </div>
  )
}

function KioskContent() {
  const { event, primaryColor, useDarkText, theme } = useEventContext()
  const [searchQuery, setSearchQuery] = useState('')
  const [results, setResults] = useState<Registrant[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [selectedRegistrant, setSelectedRegistrant] = useState<Registrant | null>(null)
  const [editForm, setEditForm] = useState<EditForm>({ first_name: '', last_name: '', company: '', job_title: '' })
  const [isSaving, setIsSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const textColor = useDarkText ? 'text-gray-900' : 'text-white'
  const mutedColor = useDarkText ? 'text-gray-600' : 'text-white/60'
  const panelClasses = `${theme.panelBg} backdrop-blur-[10px] rounded-2xl shadow-2xl ${theme.panelBorder}`

  const searchRegistrants = useCallback(async (query: string) => {
    if (query.trim().length < 2) {
      setResults([])
      return
    }

    setIsSearching(true)
    try {
      const supabase = getSupabaseClient()
      const trimmed = query.trim().toLowerCase()

      const { data, error } = await supabase
        .from('events_registrations_with_people')
        .select('id, email, person_id, first_name, last_name, company, job_title, status, attributes')
        .eq('event_id', event.id)
        .neq('status', 'cancelled')
        .or(`email.ilike.%${trimmed}%,first_name.ilike.%${trimmed}%,last_name.ilike.%${trimmed}%,full_name.ilike.%${trimmed}%`)
        .order('first_name', { ascending: true })
        .limit(20)

      if (error) throw error
      setResults((data as Registrant[]) || [])
    } catch (err) {
      console.error('Kiosk search error:', err)
      setResults([])
    } finally {
      setIsSearching(false)
    }
  }, [event.id])

  const handleSearchChange = (value: string) => {
    setSearchQuery(value)
    setSaveMessage(null)

    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
    searchTimeoutRef.current = setTimeout(() => {
      searchRegistrants(value)
    }, 300)
  }

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
    }
  }, [])

  const selectRegistrant = (registrant: Registrant) => {
    setSelectedRegistrant(registrant)
    setEditForm({
      first_name: registrant.first_name || '',
      last_name: registrant.last_name || '',
      company: registrant.company || '',
      job_title: registrant.job_title || '',
    })
    setSaveMessage(null)
  }

  const handleSave = async () => {
    if (!selectedRegistrant) return

    setIsSaving(true)
    setSaveMessage(null)

    try {
      const supabase = getSupabaseClient()

      // Merge updated fields into existing attributes
      const updatedAttributes = {
        ...(selectedRegistrant.attributes || {}),
        first_name: editForm.first_name.trim(),
        last_name: editForm.last_name.trim(),
        company: editForm.company.trim(),
        job_title: editForm.job_title.trim(),
      }

      const { error } = await supabase
        .from('people')
        .update({ attributes: updatedAttributes })
        .eq('id', selectedRegistrant.person_id)

      if (error) throw error

      // Update local state
      setSelectedRegistrant({
        ...selectedRegistrant,
        first_name: editForm.first_name.trim(),
        last_name: editForm.last_name.trim(),
        company: editForm.company.trim(),
        job_title: editForm.job_title.trim(),
        attributes: updatedAttributes,
      })

      setResults(prev => prev.map(r =>
        r.id === selectedRegistrant.id
          ? { ...r, first_name: editForm.first_name.trim(), last_name: editForm.last_name.trim(), company: editForm.company.trim(), job_title: editForm.job_title.trim(), attributes: updatedAttributes }
          : r
      ))

      setSaveMessage({ type: 'success', text: 'Changes saved successfully!' })
    } catch (err) {
      console.error('Kiosk save error:', err)
      setSaveMessage({ type: 'error', text: 'Failed to save changes. Please try again.' })
    } finally {
      setIsSaving(false)
    }
  }

  const handleBack = () => {
    setSelectedRegistrant(null)
    setSaveMessage(null)
  }

  const inputClasses = `w-full px-4 py-3 border ${
    useDarkText ? 'bg-black/40 border-white/20' : 'bg-white/60 border-white/30'
  } text-gray-900 placeholder-gray-500 text-sm`

  return (
    <>
      {/* Search */}
      <div className={`${panelClasses} p-6`}>
        <label className={`block text-sm font-medium mb-2 ${textColor}`}>
          Search by email, first name, or last name
        </label>
        <GlowInput
          glowColor={primaryColor}
          borderRadius="0.75rem"
          type="text"
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Enter email address or name..."
          className={inputClasses}
          autoFocus
        />
        {isSearching && (
          <p className={`text-sm mt-2 ${mutedColor}`}>Searching...</p>
        )}
      </div>

      {/* Results list */}
      {!selectedRegistrant && results.length > 0 && (
        <div className={`${panelClasses} overflow-hidden`}>
          <div className="divide-y divide-white/10">
            {results.map((registrant) => (
              <button
                key={registrant.id}
                onClick={() => selectRegistrant(registrant)}
                className="w-full px-6 py-4 flex items-center justify-between hover:bg-white/10 transition-colors cursor-pointer text-left"
              >
                <div>
                  <p className={`font-medium ${textColor}`}>
                    {[registrant.first_name, registrant.last_name].filter(Boolean).join(' ') || 'No name'}
                  </p>
                  <p className={`text-sm ${mutedColor}`}>{registrant.email}</p>
                  {(registrant.company || registrant.job_title) && (
                    <p className={`text-xs mt-0.5 ${mutedColor}`}>
                      {[registrant.job_title, registrant.company].filter(Boolean).join(' at ')}
                    </p>
                  )}
                </div>
                <svg className={`w-5 h-5 flex-shrink-0 ${mutedColor}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* No results */}
      {!selectedRegistrant && !isSearching && searchQuery.trim().length >= 2 && results.length === 0 && (
        <div className={`${panelClasses} p-6 text-center`}>
          <p className={mutedColor}>No registrants found matching &ldquo;{searchQuery}&rdquo;</p>
        </div>
      )}

      {/* Edit form */}
      {selectedRegistrant && (
        <div className={`${panelClasses} p-6 space-y-5`}>
          <div className="flex items-center justify-between">
            <div>
              <p className={`text-lg font-semibold ${textColor}`}>
                {[selectedRegistrant.first_name, selectedRegistrant.last_name].filter(Boolean).join(' ') || 'No name'}
              </p>
              <p className={`text-sm ${mutedColor}`}>{selectedRegistrant.email}</p>
            </div>
            <button
              onClick={handleBack}
              className={`text-sm ${mutedColor} hover:opacity-80 transition-opacity cursor-pointer flex items-center gap-1`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to results
            </button>
          </div>

          <div className={`h-px ${useDarkText ? 'bg-gray-700/30' : 'bg-white/20'}`} />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={`block text-sm font-medium mb-1.5 ${textColor}`}>First Name</label>
              <GlowInput
                glowColor={primaryColor}
                borderRadius="0.75rem"
                type="text"
                value={editForm.first_name}
                onChange={(e) => setEditForm(prev => ({ ...prev, first_name: e.target.value }))}
                placeholder="First name"
                className={inputClasses}
              />
            </div>
            <div>
              <label className={`block text-sm font-medium mb-1.5 ${textColor}`}>Last Name</label>
              <GlowInput
                glowColor={primaryColor}
                borderRadius="0.75rem"
                type="text"
                value={editForm.last_name}
                onChange={(e) => setEditForm(prev => ({ ...prev, last_name: e.target.value }))}
                placeholder="Last name"
                className={inputClasses}
              />
            </div>
            <div>
              <label className={`block text-sm font-medium mb-1.5 ${textColor}`}>Job Title</label>
              <GlowInput
                glowColor={primaryColor}
                borderRadius="0.75rem"
                type="text"
                value={editForm.job_title}
                onChange={(e) => setEditForm(prev => ({ ...prev, job_title: e.target.value }))}
                placeholder="Job title"
                className={inputClasses}
              />
            </div>
            <div>
              <label className={`block text-sm font-medium mb-1.5 ${textColor}`}>Company</label>
              <GlowInput
                glowColor={primaryColor}
                borderRadius="0.75rem"
                type="text"
                value={editForm.company}
                onChange={(e) => setEditForm(prev => ({ ...prev, company: e.target.value }))}
                placeholder="Company"
                className={inputClasses}
              />
            </div>
          </div>

          <div className="flex items-center gap-4">
            <PortalButton
              variant="primary"
              primaryColor={primaryColor}
              onClick={handleSave}
              disabled={isSaving}
              isLoading={isSaving}
            >
              Save Changes
            </PortalButton>

            {saveMessage && (
              <p className={`text-sm ${
                saveMessage.type === 'success' ? 'text-green-400' : 'text-red-400'
              }`}>
                {saveMessage.text}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  )
}
