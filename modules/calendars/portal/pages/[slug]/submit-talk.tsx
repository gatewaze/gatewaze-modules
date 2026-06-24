// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { notFound } from 'next/navigation'
import { getCalendarWithEvents, getCalendarSubNavVisibility, getViewerPersonId } from '../../lib/calendars'
import { CalendarHero } from '../../components/CalendarHero'
import { CalendarHeader } from '../../components/CalendarHeader'
import { getServerBrandConfig } from '@/config/brand'

interface Props {
  params: { slug: string }
}

export default async function CalendarSubmitTalkPage({ params }: Props) {
  const slug = params.slug
  const result = await getCalendarWithEvents(slug)
  if (!result) notFound()

  const { calendar } = result
  const viewerPersonId = await getViewerPersonId()
  const [visibility, brandConfig] = await Promise.all([
    getCalendarSubNavVisibility(calendar.id, viewerPersonId),
    getServerBrandConfig(),
  ])

  let SubmitTalkForm: any = null
  try {
    const mod = await import(
      /* @vite-ignore */ '../../../../event-speakers/portal/calendar-pages/submit-talk'
    )
    SubmitTalkForm = mod.SubmitTalkForm
  } catch {
    // event-speakers module not installed
  }

  return (
    <div className="pub-wrap">
      <CalendarHero calendar={calendar} storageBucketUrl={brandConfig.storageBucketUrl} />
      <CalendarHeader
        calendar={calendar}
        visibility={visibility}
        active="submit-talk"
        primaryColor={brandConfig.primaryColor}
      />

      <div>
        <h2 style={{ font: '600 30px var(--font-display)', color: 'var(--ink)', letterSpacing: '-0.02em', margin: '0 0 12px' }}>Submit a talk</h2>
        <p style={{ color: 'var(--ink-3)', margin: '0 0 32px', maxWidth: '42rem', fontSize: 15, lineHeight: 1.6 }}>
          Tell us about you and the talk you'd like to give. Chapter organisers review
          submissions and reach out when they can put on an event that fits.
        </p>

        {SubmitTalkForm ? (
          <SubmitTalkForm calendar={calendar} primaryColor={brandConfig.primaryColor} />
        ) : (
          <div className="pub-empty" style={{ marginTop: 0 }}>
            <h3 style={{ font: '600 18px var(--font-display)', color: 'var(--ink)', margin: 0 }}>Submissions not available</h3>
            <p style={{ color: 'var(--ink-3)', marginTop: 8 }}>
              The speakers module is not installed on this brand.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
