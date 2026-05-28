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

  // Mirrors `<TimelineTabs>` (packages/portal/components/timeline/TimelineTabs.tsx)
  // exactly so the calendar microsite uses the same nav language as the
  // brand's events page.
  return (
    <div
      className="flex w-full sm:inline-flex sm:w-auto p-1 gap-1 mb-8"
      style={{
        borderRadius: 'var(--radius-control-outer)',
        backgroundColor: `rgba(var(--panel-tint,0,0,0),var(--glass-opacity,0.05))`,
        backdropFilter: `blur(var(--glass-blur,4px))`,
        WebkitBackdropFilter: `blur(var(--glass-blur,4px))`,
        border: `1px solid rgba(var(--panel-tint,0,0,0),var(--glass-border-opacity,0.1))`,
      }}
    >
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
      className={`
        cursor-pointer flex items-center justify-center gap-1 flex-1 sm:flex-initial px-4 py-2 text-base font-medium transition-all duration-200 ease-out
        ${active ? 'shadow-lg' : 'text-white/70 hover:text-white hover:bg-white/10'}
      `}
      style={{
        borderRadius: 'var(--radius-control)',
        ...(active ? { backgroundColor: primaryColor, color: lightPrimary ? '#000000' : '#ffffff' } : {}),
      }}
    >
      {children}
    </Link>
  )
}
