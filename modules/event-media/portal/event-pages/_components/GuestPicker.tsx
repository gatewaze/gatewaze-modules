'use client'

// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * "Who are you?" for an event with an invitation list.
 *
 * The guest types and chooses themselves from the people who accepted --
 * "da" offers Dan and David -- and cannot enter a name that is not on the
 * list. The server does the searching (a handful of matches, two letters
 * minimum), so the page never holds the whole guest list.
 */

import { useEffect, useRef, useState } from 'react'

interface Props {
  code: string
  darkMode?: boolean
  onPick: (guest: { id: string; name: string }) => void
}

const DEBOUNCE_MS = 220

export default function GuestPicker({ code, darkMode, onPick }: Props) {
  const [q, setQ] = useState('')
  const [matches, setMatches] = useState<Array<{ id: string; name: string }>>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState('')
  const seq = useRef(0)

  useEffect(() => {
    const query = q.trim()
    if (query.length < 2) { setMatches([]); setSearched(''); return }
    const mine = ++seq.current
    setSearching(true)
    const t = setTimeout(() => {
      fetch(`/api/public/event-media/links/${code}/guests?${new URLSearchParams({ q: query })}`)
        .then((r) => (r.ok ? r.json() : { guests: [] }))
        .then((data) => {
          // Only the latest keystroke's answer counts.
          if (mine !== seq.current) return
          setMatches(Array.isArray(data?.guests) ? data.guests : [])
          setSearched(query)
        })
        .catch(() => { if (mine === seq.current) setMatches([]) })
        .finally(() => { if (mine === seq.current) setSearching(false) })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [q, code])

  const border = darkMode ? 'border-white/20' : 'border-gray-200'
  const rowText = darkMode ? 'text-white' : 'text-gray-900'
  const hint = darkMode ? 'text-gray-300' : 'text-gray-500'
  const noneFound = !searching && searched.length >= 2 && searched === q.trim() && matches.length === 0

  return (
    <div>
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Start typing your name"
        autoComplete="off"
        autoCapitalize="words"
        spellCheck={false}
        aria-label="Your name"
        role="combobox"
        aria-expanded={matches.length > 0}
        maxLength={60}
        className={darkMode ? undefined : 'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-gray-900 text-base'}
        style={darkMode ? {
          width: '100%', height: 50, borderRadius: 14, padding: '0 16px', fontSize: 17, color: '#fff',
          background: 'rgba(255,255,255,.1)', border: '1px solid rgba(255,255,255,.28)', outline: 'none',
        } : undefined}
      />
      {matches.length > 0 && (
        <ul
          role="listbox"
          className={darkMode ? undefined : `mt-2 rounded-lg border ${border} overflow-hidden`}
          style={darkMode ? {
            listStyle: 'none', margin: '10px 0 0', padding: 0, borderRadius: 14, overflow: 'hidden',
            background: 'rgba(10,8,20,.55)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.16)',
          } : undefined}
        >
          {matches.map((g, i) => (
            <li key={g.id}>
              <button
                type="button"
                role="option"
                onClick={() => onPick(g)}
                className={darkMode ? undefined : `w-full text-left px-4 py-4 text-lg ${rowText} hover:bg-gray-50 border-b last:border-b-0 ${border}`}
                style={darkMode ? {
                  // Big enough to hit with a thumb: 56px+ rows, 18px names.
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
                  minHeight: 58, padding: '16px 18px', fontSize: 18, fontWeight: 600, color: '#fff', textAlign: 'left',
                  background: 'transparent', border: 0,
                  borderTop: i === 0 ? 0 : '1px solid rgba(255,255,255,.1)', cursor: 'pointer',
                } : undefined}
              >
                {g.name}
                {darkMode && <span aria-hidden="true" style={{ opacity: 0.5 }}>›</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {q.trim().length > 0 && q.trim().length < 2 && (
        <p className={`text-xs mt-2 ${hint}`}>Keep typing…</p>
      )}
      {noneFound && (
        <p className={`text-sm mt-2 ${hint}`}>
          No one by that name on the guest list. Try your first name as it was on your invitation.
        </p>
      )}
      <p className={`text-xs mt-3 ${hint}`}>
        Choose your name from the list — it&apos;s remembered on this device.
      </p>
    </div>
  )
}
