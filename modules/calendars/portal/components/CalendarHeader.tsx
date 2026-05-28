// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { CalendarSubNav } from './CalendarSubNav'
import type { Calendar, CalendarSubNavVisibility } from '../lib/types'

interface Props {
  calendar: Calendar
  visibility: CalendarSubNavVisibility
  active: '' | 'events' | 'media' | 'chat' | 'leaderboard' | 'submit-talk' | 'about' | 'join'
  /** Brand primary colour, threaded down to the sub-nav active tab. */
  primaryColor?: string
}

/**
 * Sub-nav wrapper for calendar microsite pages. The visual page header
 * (logo, name, description, Join CTA) lives in `<CalendarHero>` which
 * is rendered immediately above this on every page.
 */
export function CalendarHeader({ calendar, visibility, active, primaryColor }: Props) {
  const slug = calendar.slug || calendar.calendar_id
  return (
    <CalendarSubNav
      calendarSlug={slug}
      active={active}
      visibility={visibility}
      primaryColor={primaryColor}
    />
  )
}
