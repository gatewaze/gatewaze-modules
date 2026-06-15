// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { getSupabaseClient } from '@/lib/supabase/client'
import { editionFolderSlug } from '@gatewaze-modules/newsletters/lib/edition-slug'

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

  // White-label: workspace-shell pub-* design system; renders inside the shell content area.
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
        <p>Subscribe to our editions and read the latest issues.</p>
      </div>

      {data.map(({ newsletter, editions }) => (
        <section key={newsletter.id} className="pub-sec">
          <div className="pub-nl-head">
            <span className="pub-nl-bar" style={{ background: newsletter.accent_color || 'var(--accent)' }} />
            <div className="grow">
              <h2 className="pub-nl-name">{newsletter.name}</h2>
              {newsletter.description && <p className="pub-nl-desc">{newsletter.description}</p>}
            </div>
            {newsletter.require_login && <span className="pub-cat">Subscribers only</span>}
            {newsletter.content_category && (
              <span className="pub-cat" style={newsletter.accent_color ? { color: newsletter.accent_color } : undefined}>
                {newsletter.content_category}
              </span>
            )}
          </div>

          <div className="pub-grid">
            {editions.map((edition) => (
              <Link
                key={edition.id}
                href={`/newsletters/${newsletter.slug}/${editionFolderSlug(edition.edition_date, edition.title)}`}
                className="pub-card"
                style={{ borderTop: `3px solid ${newsletter.accent_color || 'var(--accent)'}` }}
              >
                <div className="pub-card-body" style={{ padding: '4px 6px' }}>
                  <div className="pub-meta" style={{ marginTop: 0 }}>{formatDate(edition.edition_date)}</div>
                  <h3>{edition.title || 'Untitled Edition'}</h3>
                  {edition.preheader && <p>{edition.preheader}</p>}
                </div>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
