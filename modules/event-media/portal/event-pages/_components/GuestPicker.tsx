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
        className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-gray-900 text-base"
      />
      {matches.length > 0 && (
        <ul role="listbox" className={`mt-2 rounded-lg border ${border} overflow-hidden`}>
          {matches.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                role="option"
                onClick={() => onPick(g)}
                className={`w-full text-left px-3 py-3 text-base ${rowText} ${darkMode ? 'hover:bg-white/10' : 'hover:bg-gray-50'} border-b last:border-b-0 ${border}`}
              >
                {g.name}
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
