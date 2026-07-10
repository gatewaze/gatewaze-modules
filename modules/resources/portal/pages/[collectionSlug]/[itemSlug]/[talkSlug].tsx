// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { notFound } from 'next/navigation'
import ItemDetailPage from '../[itemSlug]'
import { TocSpy } from '../../../components/TocSpy'

/**
 * Deep link to a single block inside a resource item, e.g. a talk card in a
 * conference recap: /resources/{collection}/{item}/{talk-slug}.
 *
 * Renders the full item page and auto-scrolls to the element whose id equals
 * the third segment (content authors give shareable blocks stable ids like
 * `talk-<slug>`). Per-talk social preview metadata is assembled by the portal
 * catch-all's generateMetadata, which owns metadata for all module routes.
 */

interface Props {
  params: { collectionSlug: string; itemSlug: string; talkSlug: string }
  searchParams?: Record<string, string | string[] | undefined>
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/

async function anchorExists(collectionSlug: string, itemSlug: string, anchorId: string): Promise<boolean> {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) return false

  const cookieStore = await cookies()
  const supabase = createServerClient(url, key, {
    cookies: { get(name: string) { return cookieStore.get(name)?.value } },
  })

  const { data: collection } = await supabase
    .from('sr_collections')
    .select('id')
    .eq('slug', collectionSlug)
    .eq('status', 'published')
    .maybeSingle()
  if (!collection) return false

  const { data: item } = await supabase
    .from('sr_items')
    .select('id, sections:sr_sections(content)')
    .eq('collection_id', collection.id)
    .eq('slug', itemSlug)
    .eq('status', 'published')
    .maybeSingle()
  if (!item) return false

  const needle = `id="${anchorId}"`
  return (item.sections || []).some((s: { content: string | null }) => (s.content || '').includes(needle))
}

export default async function ResourceItemAnchorPage({ params, searchParams }: Props) {
  const { collectionSlug, itemSlug, talkSlug } = params

  if (!SLUG_RE.test(talkSlug) || !(await anchorExists(collectionSlug, itemSlug, talkSlug))) {
    notFound()
  }


  return (
    <>
      {/* client-side focus: scrolls to the anchored block and highlights it;
          survives soft navigations and post-hydration shell remounts */}
      <TocSpy focusId={talkSlug} />
      <ItemDetailPage params={params} searchParams={searchParams} />
    </>
  )
}
