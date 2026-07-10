// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { getSupabaseClient } from '@/lib/supabase/client'
import { editionFolderSlug } from '@gatewaze-modules/newsletters/lib/edition-slug'
import { NewsletterSignup, SubscribedPanel, useNewsletterSubscription } from '../components/NewsletterSignup'
import { ConsentNote } from '../components/ConsentNote'
// When the onboarding module is installed + enabled it registers the
// 'newsletters:signup' slot (the email→chat morph). Importing ModuleSlot runs
// the generated slot registrations as a side-effect.
import { ModuleSlot, hasPortalSlot } from '@/lib/modules/ModuleSlot'

// Render the onboarding morph when the slot is registered AND its required
// feature is satisfied, otherwise the plain signup form. Using the same id +
// feature sets in the decision and in <ModuleSlot> keeps them in agreement, so
// ModuleSlot can never filter the component out and return null (which would
// blank the field). The morph degrades to a plain subscribe via onFallbackSubscribe.
const ONB_IDS = new Set(['onboarding'])
function NewsletterSignupSurface({ collectionSlug }: { collectionSlug: string }) {
  // Subscription state is decided HERE, above the morph: an already-subscribed
  // signed-in user gets the subscribed panel and the onboarding morph (which
  // would otherwise replace it with its own email field once hydrated) plus
  // the consent note are not rendered at all.
  const subscription = useNewsletterSubscription(collectionSlug)
  let useMorph = false
  try { useMorph = hasPortalSlot('newsletters:signup', ONB_IDS, ONB_IDS) } catch { useMorph = false }

  if (subscription.sub?.subscribed) {
    return (
      <SubscribedPanel
        sub={subscription.sub}
        unsubState={subscription.unsubState}
        unsubscribe={subscription.unsubscribe}
      />
    )
  }
  // Signed in but status still resolving: render nothing for a beat rather
  // than mounting the morph and yanking it away if the answer is "subscribed".
  if (subscription.user && subscription.sub === undefined) return null

  if (!useMorph) return <NewsletterSignup collectionSlug={collectionSlug} subscription={subscription} />
  const fallbackSubscribe = async (email: string) => {
    try {
      const sb = getSupabaseClient()
      await sb.functions.invoke('newsletter-signup', { body: { email, collection: collectionSlug } })
    } catch { /* best-effort */ }
  }
  return (
    <>
      <ModuleSlot
        name="newsletters:signup"
        enabledModuleIds={['onboarding']}
        enabledFeatures={['onboarding']}
        props={{ collectionSlug, onFallbackSubscribe: fallbackSubscribe }}
        fallback={<NewsletterSignup collectionSlug={collectionSlug} subscription={subscription} />}
      />
      {/* The plain NewsletterSignup renders its own consent note; the onboarding
          morph doesn't, so add it here for that branch. */}
      <ConsentNote />
    </>
  )
}

const RECENT_LIMIT = 6

interface Newsletter {
  id: string
  name: string
  slug: string
  description: string | null
  accent_color: string | null
  content_category: string | null
  require_login: boolean
}

interface Edition {
  id: string
  title: string | null
  edition_date: string
  collection_id: string
  preheader: string | null
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function humanizeCategory(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

export default function NewsletterListingPage() {
  const [data, setData] = useState<{ newsletter: Newsletter; editions: Edition[] }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const supabase = getSupabaseClient()
        // RLS handles visibility — anon sees only public newsletters.
        const { data: newsletters } = await supabase
          .from('newsletters_template_collections')
          .select('id, name, slug, description, accent_color, content_category, require_login')
          .eq('setup_complete', true)
          .order('name')

        if (!newsletters || newsletters.length === 0) {
          setData([])
          setLoading(false)
          return
        }

        const { data: editions } = await supabase
          .from('newsletters_editions')
          .select('id, title, edition_date, collection_id, preheader')
          .eq('status', 'published')
          .order('edition_date', { ascending: false })

        const byCollection = new Map<string, Edition[]>()
        for (const ed of editions || []) {
          const list = byCollection.get(ed.collection_id) || []
          list.push(ed)
          byCollection.set(ed.collection_id, list)
        }

        setData(
          newsletters
            .filter((nl) => byCollection.has(nl.id))
            .map((nl) => ({ newsletter: nl, editions: byCollection.get(nl.id) || [] })),
        )
      } catch (err) {
        console.error('Error loading newsletters:', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  if (loading) {
    return (
      <div className="pub-wrap">
        <div className="pub-h"><h1>Newsletters</h1></div>
        <div className="pub-empty">Loading…</div>
      </div>
    )
  }

  if (data.length === 0) {
    return (
      <div className="pub-wrap">
        <div className="pub-h"><h1>Newsletters</h1></div>
        <div className="pub-empty">No newsletters available yet.</div>
      </div>
    )
  }

  return (
    <div className="pub-wrap pub-fade">
      <div className="pub-h">
        <h1>Newsletters</h1>
        <p>Subscribe to a newsletter and catch up on recent editions.</p>
      </div>

      {data.map(({ newsletter, editions }) => {
        const editionHref = (ed: Edition) =>
          `/newsletters/${newsletter.slug}/${editionFolderSlug(ed.edition_date, ed.title)}`
        const latest = editions[0]
        const recent = editions.slice(1, RECENT_LIMIT)
        const cardStyle = newsletter.accent_color ? ({ ['--nl-accent']: newsletter.accent_color } as React.CSSProperties) : undefined
        return (
          <section key={newsletter.id} className="pub-nl">
            <div className="pub-nl-card" style={cardStyle}>
              <div className="pub-nl-top">
                <div className="pub-nl-id">
                  <div className="pub-nl-titlerow">
                    <h2 className="pub-nl-name">
                      <Link href={`/newsletters/${newsletter.slug}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                        {newsletter.name}
                      </Link>
                    </h2>
                    {newsletter.content_category && (
                      <span className="pub-nl-badge">{humanizeCategory(newsletter.content_category)}</span>
                    )}
                  </div>
                  {newsletter.description && <p className="pub-nl-desc">{newsletter.description}</p>}
                  {newsletter.require_login ? (
                    <p className="pub-nl-note">Subscribers only — sign in to read.</p>
                  ) : (
                    // Boxed sub-panel so the signup reads as its own unit rather
                    // than blending into the editions content beside/below it.
                    <div className="pub-nl-sub">
                      <div className="pub-nl-sub-h">Get new editions in your inbox</div>
                      <NewsletterSignupSurface collectionSlug={newsletter.slug} />
                    </div>
                  )}
                </div>
              </div>

              <div className="pub-nl-editions">
                {latest && (
                  <Link href={editionHref(latest)} className="pub-nl-feature">
                    <div style={{ minWidth: 0 }}>
                      <div className="eyebrow">Latest edition</div>
                      <div className="date">{formatDate(latest.edition_date)}</div>
                      <h3>{latest.title || 'Untitled edition'}</h3>
                      {latest.preheader && <p>{latest.preheader}</p>}
                    </div>
                    <span className="arrow" aria-hidden>→</span>
                  </Link>
                )}
                {recent.length > 0 && (
                  <>
                    <div className="pub-nl-eyebrow">Past editions</div>
                    <ul className="pub-nl-rows">
                      {recent.map((edition) => (
                        <li key={edition.id}>
                          <Link href={editionHref(edition)} className="pub-nl-row">
                            <span className="pub-nl-row-date">{formatDate(edition.edition_date)}</span>
                            <span className="pub-nl-row-main">
                              <span className="pub-nl-row-title">{edition.title || 'Untitled edition'}</span>
                              {edition.preheader && <span className="pub-nl-row-pre">{edition.preheader}</span>}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {editions.length > RECENT_LIMIT && (
                  <Link href={`/newsletters/${newsletter.slug}`} className="pub-nl-viewall">
                    View all {editions.length} editions →
                  </Link>
                )}
              </div>
            </div>
          </section>
        )
      })}
    </div>
  )
}
