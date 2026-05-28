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
    <main className="relative z-10">
      <div className="max-w-7xl mx-auto px-6 sm:px-6 lg:px-8 py-8 sm:py-12">
        <CalendarHero calendar={calendar} storageBucketUrl={brandConfig.storageBucketUrl} />
        <CalendarHeader
          calendar={calendar}
          visibility={visibility}
          active="submit-talk"
          primaryColor={brandConfig.primaryColor}
        />

        <div>
          <h2 className="text-white text-3xl font-bold mb-3">Submit a talk</h2>
          <p className="text-white/70 mb-8 max-w-2xl">
            Tell us about you and the talk you'd like to give. Chapter organisers review
            submissions and reach out when they can put on an event that fits.
          </p>

          {SubmitTalkForm ? (
            <SubmitTalkForm calendar={calendar} primaryColor={brandConfig.primaryColor} />
          ) : (
            <div className="text-center py-16">
              <h3 className="text-white text-xl font-bold">Submissions not available</h3>
              <p className="text-white/60 mt-2">
                The speakers module is not installed on this brand.
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
