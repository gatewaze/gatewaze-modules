// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

/**
 * /newsletters/<collection> — a single newsletter's page: header (name, category, description),
 * a signup form, and the full list of published editions.
 *
 * Also absorbs the legacy single-segment edition link /newsletters/<slug>--<date> (old format): when
 * the param contains "--" it resolves the edition and redirects to the canonical
 * /newsletters/<collection>/<date-subject-slug> URL, so previously-shared links keep working.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { getSupabaseClient } from '@/lib/supabase/client'
import { editionFolderSlug } from '@gatewaze-modules/newsletters/lib/edition-slug'
import { NewsletterSignup } from '../../components/NewsletterSignup'

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
  preheader: string | null
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function humanizeCategory(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

export default function NewsletterCollectionPage({ params }: { params: { collection: string } }) {
  const router = useRouter()
  const raw = params.collection || ''
  const isLegacy = raw.includes('--')

  const [newsletter, setNewsletter] = useState<Newsletter | null>(null)
  const [editions, setEditions] = useState<Edition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const supabase = getSupabaseClient()

        // Legacy /newsletters/<slug>--<date> → redirect to the canonical edition URL.
        if (isLegacy) {
          const [slug, date] = raw.split('--')
          const { data: nl } = await supabase
            .from('newsletters_template_collections')
            .select('id, slug')
            .eq('slug', slug)
            .single()
          if (!nl) { setError('Newsletter not found'); setLoading(false); return }
          const { data: ed } = await supabase
            .from('newsletters_editions')
            .select('title, edition_date')
            .eq('collection_id', nl.id)
            .eq('edition_date', date)
            .eq('status', 'published')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          if (!ed) { setError('Edition not found'); setLoading(false); return }
          router.replace(`/newsletters/${nl.slug}/${editionFolderSlug(ed.edition_date, ed.title)}`)
          return
        }

        const { data: nl } = await supabase
          .from('newsletters_template_collections')
          .select('id, name, slug, description, accent_color, content_category, require_login')
          .eq('slug', raw)
          .eq('setup_complete', true)
          .maybeSingle()
        if (!nl) { setError('Newsletter not found'); setLoading(false); return }
        setNewsletter(nl)

        const { data: eds } = await supabase
          .from('newsletters_editions')
          .select('id, title, edition_date, preheader')
          .eq('collection_id', nl.id)
          .eq('status', 'published')
          .order('edition_date', { ascending: false })
        setEditions(eds || [])
        setLoading(false)
      } catch {
        setError('Failed to load newsletter')
        setLoading(false)
      }
    }
    load()
  }, [raw, isLegacy, router])

  if (loading) {
    return <div className="pub-wrap"><div className="pub-empty">Loading…</div></div>
  }

  if (error || !newsletter) {
    return (
      <div className="pub-wrap">
        <div className="pub-h"><h1>Newsletter</h1></div>
        <div className="pub-empty">
          {error || 'Not found'}. <Link href="/newsletters" className="pub-nl-viewall" style={{ marginTop: 0 }}>Back to newsletters</Link>
        </div>
      </div>
    )
  }

  const accent = newsletter.accent_color || 'var(--accent)'
  return (
    <div className="pub-wrap pub-fade">
      <div className="pub-h">
        <div className="pub-nl-titlerow">
          <span className="pub-nl-bar" style={{ background: accent }} />
          <h1 style={{ margin: 0 }}>{newsletter.name}</h1>
          {newsletter.content_category && (
            <span className="pub-nl-badge">{humanizeCategory(newsletter.content_category)}</span>
          )}
        </div>
        {newsletter.description && <p>{newsletter.description}</p>}
      </div>

      {newsletter.require_login ? (
        <p className="pub-nl-note">Subscribers only — sign in to read the editions.</p>
      ) : (
        <div style={{ maxWidth: 480, marginBottom: 8 }}>
          <NewsletterSignup collectionSlug={newsletter.slug} />
        </div>
      )}

      {editions.length === 0 ? (
        <div className="pub-empty">No editions published yet.</div>
      ) : (
        <ul className="pub-nl-list" style={{ marginTop: 20 }}>
          {editions.map((edition) => (
            <li key={edition.id}>
              <Link
                href={`/newsletters/${newsletter.slug}/${editionFolderSlug(edition.edition_date, edition.title)}`}
                className="pub-nl-row"
              >
                <span className="pub-nl-row-date">{formatDate(edition.edition_date)}</span>
                <span className="pub-nl-row-title">{edition.title || 'Untitled edition'}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
