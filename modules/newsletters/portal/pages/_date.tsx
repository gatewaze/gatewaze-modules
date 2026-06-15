// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

// Legacy route: /newsletters/<slug>--<date>. Editions now live at the canonical
// nested path /newsletters/<collection>/<date-subject-slug> (rendered by
// _collection/_edition.tsx). This page resolves the old single-segment link and
// redirects to the canonical URL so previously-shared links keep working.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { getSupabaseClient } from '@/lib/supabase/client'
import { editionFolderSlug } from '@gatewaze-modules/newsletters/lib/edition-slug'

export default function LegacyNewsletterEditionRedirect({ params }: { params: { date: string } }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  // Old format: /newsletters/{slug}--{date}
  const parts = params.date?.split('--') || []
  const slug = parts.length > 1 ? parts[0] : ''
  const date = parts.length > 1 ? parts[1] : params.date

  useEffect(() => {
    if (!slug || !date) {
      setError('Invalid URL')
      return
    }

    async function resolve() {
      try {
        const supabase = getSupabaseClient()
        const { data: newsletter } = await supabase
          .from('newsletters_template_collections')
          .select('id, slug')
          .eq('slug', slug)
          .single()
        if (!newsletter) {
          setError('Newsletter not found')
          return
        }
        const { data: ed } = await supabase
          .from('newsletters_editions')
          .select('title, edition_date')
          .eq('collection_id', newsletter.id)
          .eq('edition_date', date)
          .eq('status', 'published')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (!ed) {
          setError('Edition not found')
          return
        }
        router.replace(`/newsletters/${newsletter.slug}/${editionFolderSlug(ed.edition_date, ed.title)}`)
      } catch {
        setError('Failed to load newsletter')
      }
    }
    resolve()
  }, [slug, date, router])

  return (
    <main className="relative z-10">
      <div className="max-w-7xl mx-auto px-6 py-12 text-center">
        {error ? (
          <>
            <h1 className="text-2xl font-bold text-white mb-4">{error}</h1>
            <Link href="/newsletters" className="text-white/60 hover:text-white underline">
              Back to newsletters
            </Link>
          </>
        ) : (
          <div className="flex justify-center">
            <div className="animate-spin w-6 h-6 border-2 border-white/30 border-t-white rounded-full" />
          </div>
        )}
      </div>
    </main>
  )
}
