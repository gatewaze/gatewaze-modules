// @ts-nocheck — portal deps are resolved at build time via webpack alias
import Link from 'next/link'
import type { CalendarSubNavVisibility } from '../lib/types'
import { isLightColor } from '@/config/brand'

interface SubNavEntry {
  slug: string
  label: string
  always?: boolean
  visibilityKey?: keyof CalendarSubNavVisibility
}

const ENTRIES: SubNavEntry[] = [
  { slug: '', label: 'Home', always: true },
  { slug: 'events', label: 'Events', visibilityKey: 'events' },
  { slug: 'media', label: 'Media', visibilityKey: 'media' },
  { slug: 'chat', label: 'Chat', visibilityKey: 'chat' },
  { slug: 'leaderboard', label: 'Leaderboard', visibilityKey: 'leaderboard' },
  { slug: 'submit-talk', label: 'Submit Talk', visibilityKey: 'submitTalk' },
  { slug: 'about', label: 'About', visibilityKey: 'about' },
  // Note: 'join' intentionally omitted — the Join CTA lives in the
  // CalendarHero panel above this nav, so the tab would be redundant.
]

interface Props {
  calendarSlug: string
  active: '' | 'events' | 'media' | 'chat' | 'leaderboard' | 'submit-talk' | 'about' | 'join'
  visibility: CalendarSubNavVisibility
  /** Brand primary colour for the active-tab fill. Falls back to white. */
  primaryColor?: string
}

export function CalendarSubNav({ calendarSlug, active, visibility, primaryColor = '#ffffff' }: Props) {
  const visible = ENTRIES.filter(e => e.always || (e.visibilityKey && visibility[e.visibilityKey]))

  // Re-skinned to the pub-* design system. The active tab uses the brand
  // primary colour as its fill (threaded down via `primaryColor`), matching
  // the `.pub-seg-btn.on` aesthetic without the client-side sliding indicator
  // (this is a server component, so each tab paints its own active state).
  return (
    <div className="pub-seg cal-subnav" style={{ marginBottom: 28, flexWrap: 'wrap' }}>
      <style>{`
        .cal-subnav { display: inline-flex; }
        @media (max-width: 640px) { .cal-subnav { display: flex; width: 100%; } .cal-subnav .pub-seg-btn { flex: 1; } }
      `}</style>
      {visible.map((entry) => {
        const href = entry.slug
          ? `/calendars/${calendarSlug}/${entry.slug}`
          : `/calendars/${calendarSlug}`
        const isActive = entry.slug === active
        return (
          <SubNavTab
            key={entry.slug || 'home'}
            href={href}
            active={isActive}
            primaryColor={primaryColor}
          >
            {entry.label}
          </SubNavTab>
        )
      })}
    </div>
  )
}

function SubNavTab({
  href,
  active,
  primaryColor,
  children,
}: {
  href: string
  active: boolean
  primaryColor: string
  children: React.ReactNode
}) {
  const lightPrimary = isLightColor(primaryColor)
  return (
    <Link
      href={href}
      className={`pub-seg-btn${active ? ' on' : ''}`}
      style={active ? { backgroundColor: primaryColor, color: lightPrimary ? '#000000' : '#ffffff' } : undefined}
    >
      {children}
    </Link>
  )
}
