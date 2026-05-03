// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { getSupabaseClient } from '@/lib/supabase/client'

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
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export default function NewsletterListingPage() {
  const [data, setData] = useState<{ newsletter: Newsletter; editions: Edition[] }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const supabase = getSupabaseClient()

        // Query as the current user (authenticated or anon).
        // RLS policies handle visibility — anon sees only public newsletters,
        // authenticated users see all including require_login ones.
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

        const editionsByCollection = new Map<string, Edition[]>()
        for (const ed of editions || []) {
          const list = editionsByCollection.get(ed.collection_id) || []
          list.push(ed)
          editionsByCollection.set(ed.collection_id, list)
        }

        setData(
          newsletters
            .filter(nl => editionsByCollection.has(nl.id))
            .map(nl => ({
              newsletter: nl,
              editions: editionsByCollection.get(nl.id) || [],
            }))
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
      <main className="relative z-10">
        <div className="max-w-7xl mx-auto px-6 sm:px-6 lg:px-8 py-8 sm:py-12">
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-8">Newsletters</h1>
          <div className="flex justify-center py-12">
            <div className="animate-spin w-6 h-6 border-2 border-white/30 border-t-white rounded-full" />
          </div>
        </div>
      </main>
    )
  }

  if (data.length === 0) {
    return (
      <main className="relative z-10">
        <div className="max-w-7xl mx-auto px-6 sm:px-6 lg:px-8 py-8 sm:py-12">
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-8">Newsletters</h1>
          <p className="text-white/60 text-center py-12">No newsletters available yet.</p>
        </div>
      </main>
    )
  }

  return (
    <main className="relative z-10">
      <div className="max-w-7xl mx-auto px-6 sm:px-6 lg:px-8 py-8 sm:py-12">
        <h1 className="text-3xl sm:text-4xl font-bold text-white mb-8">Newsletters</h1>

        <div className="space-y-16">
          {data.map(({ newsletter, editions }) => (
            <section key={newsletter.id}>
              <div className="flex items-center gap-3 mb-6">
                <div
                  className="w-1 h-8 rounded-full"
                  style={{ backgroundColor: newsletter.accent_color || '#00a2c7' }}
                />
                <div>
                  <h2 className="text-xl sm:text-2xl font-bold text-white">{newsletter.name}</h2>
                  {newsletter.description && (
                    <p className="text-white/60 text-base mt-0.5">{newsletter.description}</p>
                  )}
                </div>
                {newsletter.require_login && (
                  <span className="text-base font-medium px-3 py-1 rounded-full bg-white/10 text-white/70">
                    Subscribers only
                  </span>
                )}
                {newsletter.content_category && (
                  <span
                    className="text-base font-medium px-3 py-1 rounded-full"
                    style={{
                      backgroundColor: (newsletter.accent_color || '#00a2c7') + '33',
                      color: newsletter.accent_color || '#00a2c7',
                    }}
                  >
                    {newsletter.content_category}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {editions.map((edition) => (
                  <Link
                    key={edition.id}
                    href={`/newsletters/${newsletter.slug}--${edition.edition_date}`}
                    className="group block"
                  >
                    <div
                      className="relative bg-white/5 rounded-xl border border-white/10 overflow-hidden hover:bg-white/10 hover:border-white/20 transition-all duration-200 p-5"
                      style={{ borderTopColor: newsletter.accent_color || '#00a2c7', borderTopWidth: '3px' }}
                    >
                      <div className="text-white/50 text-base mb-2">{formatDate(edition.edition_date)}</div>
                      <h3 className="text-white font-semibold text-lg group-hover:text-white/90 transition-colors line-clamp-2">
                        {edition.title || 'Untitled Edition'}
                      </h3>
                      {edition.preheader && (
                        <p className="text-white/60 text-base mt-2 line-clamp-2">{edition.preheader}</p>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  )
}
