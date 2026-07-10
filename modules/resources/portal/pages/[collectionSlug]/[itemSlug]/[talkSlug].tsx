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
const FALLBACK_SCAN_MAX_BYTES = 1_048_576
const FALLBACK_SCAN_MAX_MS = 50

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
    .select('id')
    .eq('collection_id', collection.id)
    .eq('slug', itemSlug)
    .eq('status', 'published')
    .maybeSingle()
  if (!item) return false

  // 1) unique-index probe: promoted anchors are sr_blocks slugs
  const { data: block } = await supabase
    .from('sr_blocks')
    .select('id')
    .eq('item_id', item.id)
    .eq('slug', anchorId)
    .maybeSingle()
  if (block) return true

  // 2) bounded, deterministic fallback: literal substring scan (never a
  //    regex) over html-kind block payloads then legacy section content, in
  //    (sort_order, id) order, for anchors never promoted to a slug (e.g.
  //    sub-anchors inside a guide chapter). Double-quoted lowercase ids only
  //    — accepted false negatives per the structured-blocks spec.
  const { data: sections } = await supabase
    .from('sr_sections')
    .select('id, content, sort_order, blocks:sr_blocks(id, kind, sort_order, data)')
    .eq('item_id', item.id)
  const needle = `id="${anchorId}"`
  const started = Date.now()
  let scanned = 0
  const overBudget = () => {
    if (scanned > FALLBACK_SCAN_MAX_BYTES || Date.now() - started > FALLBACK_SCAN_MAX_MS) {
      console.warn(JSON.stringify({ event: 'resources.anchor.fallback_cap_exceeded', item_id: item.id, anchor: anchorId }))
      return true
    }
    return false
  }
  const bySort = (a: any, b: any) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1)
  for (const section of (sections || []).sort(bySort)) {
    for (const b of (section.blocks || []).sort(bySort)) {
      if (b.kind !== 'html' || typeof b.data?.html !== 'string') continue
      scanned += b.data.html.length
      if (overBudget()) return false
      if (b.data.html.includes(needle)) {
        console.warn(JSON.stringify({ event: 'resources.anchor.fallback_hit', item_id: item.id, anchor: anchorId, source: 'block', block_id: b.id }))
        return true
      }
    }
    if (typeof section.content === 'string' && section.content.length > 0) {
      scanned += section.content.length
      if (overBudget()) return false
      if (section.content.includes(needle)) {
        console.warn(JSON.stringify({ event: 'resources.anchor.fallback_hit', item_id: item.id, anchor: anchorId, source: 'content', section_id: section.id }))
        return true
      }
    }
  }
  return false
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
