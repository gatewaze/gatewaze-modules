// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { notFound } from 'next/navigation'
import ItemDetailPage from '../[itemSlug]'

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

  // Scroll to the target card once it exists (sections stream in via
  // Suspense) and flash a highlight ring. The card lives inside
  // dangerouslySetInnerHTML content, which React never hydrates, so
  // mutating it early cannot cause hydration mismatches.
  const focusJs = [
    '(function(){',
    `var id='${talkSlug}';`,
    // streamed sections land in hidden Suspense templates before React
    // swaps them in — getClientRects() is empty until the card is really
    // visible, so keep polling past the hidden copy
    'function go(){var el=document.getElementById(id);if(!el||!el.getClientRects().length)return false;',
    "el.scrollIntoView({block:'start'});",
    "el.style.boxShadow='0 0 0 2px var(--accent)';",
    "setTimeout(function(){el.style.boxShadow='';},4000);return true;}",
    // the signed-in shell hydrates as a client component and can remount its
    // scroll container, resetting our scroll — re-assert unless the user has
    // taken over
    'var cancelled=false;',
    "['wheel','touchstart','keydown'].forEach(function(ev){window.addEventListener(ev,function(){cancelled=true;},{passive:true,once:true});});",
    'function settle(){[600,1600,3200].forEach(function(ms){setTimeout(function(){if(!cancelled)go();},ms);});}',
    'var n=0;var t=setInterval(function(){if(go()){clearInterval(t);settle();}else if(++n>80){clearInterval(t);}},200);',
    'if(go()){clearInterval(t);settle();}',
    '})();',
  ].join('')

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: focusJs }} />
      <ItemDetailPage params={params} searchParams={searchParams} />
    </>
  )
}
