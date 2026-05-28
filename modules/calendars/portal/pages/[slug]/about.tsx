// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { notFound } from 'next/navigation'
import {
  getCalendarWithEvents,
  getCalendarSubNavVisibility,
  getViewerPersonId,
} from '../../lib/calendars'
import { CalendarHero } from '../../components/CalendarHero'
import { CalendarHeader } from '../../components/CalendarHeader'
import { getServerBrandConfig } from '@/config/brand'

interface Props {
  params: { slug: string }
}

export default async function CalendarAboutPage({ params }: Props) {
  const slug = params.slug
  const result = await getCalendarWithEvents(slug)
  if (!result) notFound()

  const { calendar } = result
  const viewerPersonId = await getViewerPersonId()
  const [visibility, brandConfig] = await Promise.all([
    getCalendarSubNavVisibility(calendar.id, viewerPersonId),
    getServerBrandConfig(),
  ])

  const sections: Array<{ id: string; title: string; html: string | null }> = [
    { id: 'organisers', title: 'Organisers',  html: calendar.about_organisers },
    { id: 'faq',        title: 'FAQ',         html: calendar.about_faq        },
    { id: 'sponsors',   title: 'Sponsorship', html: calendar.about_sponsors   },
  ]

  const populated = sections.filter((s) => s.html && s.html.trim().length > 0)

  return (
    <main className="relative z-10">
      <div className="max-w-7xl mx-auto px-6 sm:px-6 lg:px-8 py-8 sm:py-12">
        <CalendarHero calendar={calendar} storageBucketUrl={brandConfig.storageBucketUrl} />
        <CalendarHeader
          calendar={calendar}
          visibility={visibility}
          active="about"
          primaryColor={brandConfig.primaryColor}
        />

        <div>
          <h2 className="text-white text-3xl font-bold mb-2">About</h2>
          {calendar.description && (
            <p className="text-white/70 mb-8 max-w-3xl">{calendar.description}</p>
          )}

          {populated.length === 0 ? (
            <div
              className="p-8 text-center overflow-hidden"
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
              <p className="text-white/60">
                The organisers haven't written anything here yet.
              </p>
            </div>
          ) : (
            <>
              {populated.length > 1 && (
                <nav className="flex flex-wrap gap-2 mb-10" aria-label="About sections">
                  {populated.map((s) => (
                    <a
                      key={s.id}
                      href={`#${s.id}`}
                      className="px-3 py-1 text-sm rounded-full bg-white/5 text-white/70 hover:bg-white/10 hover:text-white border border-white/10"
                    >
                      {s.title}
                    </a>
                  ))}
                </nav>
              )}

              <div className="space-y-12">
                {populated.map((s) => (
                  <section key={s.id} id={s.id} className="scroll-mt-24">
                    <h3 className="text-white text-2xl font-bold mb-4">{s.title}</h3>
                    <div
                      className="calendar-about-prose prose prose-invert max-w-none text-white/80"
                      dangerouslySetInnerHTML={{ __html: s.html as string }}
                    />
                  </section>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  )
}
