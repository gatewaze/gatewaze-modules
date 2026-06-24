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
    <div className="pub-wrap">
      <CalendarHero calendar={calendar} storageBucketUrl={brandConfig.storageBucketUrl} />
      <CalendarHeader
        calendar={calendar}
        visibility={visibility}
        active="about"
        primaryColor={brandConfig.primaryColor}
      />

      <div>
        <h2 style={{ font: '600 30px var(--font-display)', color: 'var(--ink)', letterSpacing: '-0.02em', margin: '0 0 8px' }}>About</h2>
        {calendar.description && (
          <p style={{ color: 'var(--ink-3)', margin: '0 0 32px', maxWidth: '48rem', fontSize: 15, lineHeight: 1.6 }}>{calendar.description}</p>
        )}

        {populated.length === 0 ? (
          <div className="pub-empty" style={{ marginTop: 0 }}>
            The organisers haven't written anything here yet.
          </div>
        ) : (
          <>
            {populated.length > 1 && (
              <nav className="pub-tags" style={{ marginBottom: 40 }} aria-label="About sections">
                {populated.map((s) => (
                  <a key={s.id} href={`#${s.id}`} className="pub-tag" style={{ textDecoration: 'none' }}>
                    {s.title}
                  </a>
                ))}
              </nav>
            )}

            <div className="pub-body" style={{ display: 'flex', flexDirection: 'column', gap: 48 }}>
              {populated.map((s) => (
                <section key={s.id} id={s.id} style={{ scrollMarginTop: 96 }}>
                  <h2>{s.title}</h2>
                  <div
                    className="calendar-about-prose"
                    dangerouslySetInnerHTML={{ __html: s.html as string }}
                  />
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
