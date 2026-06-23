// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import DOMPurify from 'isomorphic-dompurify'

interface ItemData {
  id: string
  title: string
  slug: string
  subtitle: string | null
  external_url: string | null
  featured_image_url: string | null
  category: { id: string; name: string; slug: string } | null
  sections: { id: string; heading: string; content: string | null; sort_order: number }[]
}

interface CollectionData {
  id: string
  name: string
  slug: string
  access: string
}

interface NavItem {
  title: string
  slug: string
}

async function getSession() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) return null

  const cookieStore = cookies()
  const supabase = createServerClient(url, key, {
    cookies: { get(name: string) { return cookieStore.get(name)?.value } },
  })
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

async function getItemData(collectionSlug: string, itemSlug: string, isAuthenticated: boolean) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) return null

  const cookieStore = cookies()
  const supabase = createServerClient(url, key, {
    cookies: { get(name: string) { return cookieStore.get(name)?.value } },
  })

  // Get collection
  const { data: collection } = await supabase
    .from('sr_collections')
    .select('id, name, slug, access')
    .eq('slug', collectionSlug)
    .eq('status', 'published')
    .single()

  if (!collection) return null

  const effectiveAccess = collection.access === 'public' ? 'public' : 'authenticated'
  if (effectiveAccess === 'authenticated' && !isAuthenticated) return null

  // Get item with sections
  const { data: item } = await supabase
    .from('sr_items')
    .select(`
      id, title, slug, subtitle, external_url, featured_image_url,
      category:sr_categories(id, name, slug),
      sections:sr_sections(id, heading, content, sort_order)
    `)
    .eq('collection_id', collection.id)
    .eq('slug', itemSlug)
    .eq('status', 'published')
    .single()

  if (!item) return null

  // Get prev/next items in same category
  const category = Array.isArray(item.category) ? item.category[0] : item.category
  let prevItem: NavItem | null = null
  let nextItem: NavItem | null = null

  if (category) {
    const { data: siblings } = await supabase
      .from('sr_items')
      .select('title, slug')
      .eq('category_id', category.id)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })

    if (siblings) {
      const idx = siblings.findIndex(s => s.slug === itemSlug)
      if (idx > 0) prevItem = siblings[idx - 1]
      if (idx < siblings.length - 1) nextItem = siblings[idx + 1]
    }
  }

  return {
    collection: collection as CollectionData,
    item: {
      ...item,
      category,
      sections: (item.sections || []).sort((a: any, b: any) => a.sort_order - b.sort_order),
    } as ItemData,
    prevItem,
    nextItem,
  }
}

interface Props {
  params: { collectionSlug: string; itemSlug: string }
}

export default async function ItemDetailPage({ params }: Props) {
  const session = await getSession()
  const isAuthenticated = !!session

  const data = await getItemData(params.collectionSlug, params.itemSlug, isAuthenticated)

  if (!data) {
    if (!isAuthenticated) {
      return (
        <main className="relative z-10">
          <div className="max-w-3xl mx-auto px-6 py-12 text-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/30 mx-auto mb-4">
              <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <h1 className="text-2xl font-bold text-white mb-2">Sign in required</h1>
            <p className="text-white/60 mb-6">You need to be signed in to view this resource.</p>
            <Link href="/sign-in" className="inline-block px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
              Sign In
            </Link>
          </div>
        </main>
      )
    }
    notFound()
  }

  const { collection, item, prevItem, nextItem } = data

  return (
    <main className="relative z-10">
      <div className="max-w-3xl mx-auto px-6 sm:px-6 lg:px-8 py-8 sm:py-12">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-white/40 mb-6 flex-wrap">
          <Link href="/resources" className="hover:text-white/60 transition-colors">Resources</Link>
          <span>/</span>
          <Link href={`/resources/${collection.slug}`} className="hover:text-white/60 transition-colors">{collection.name}</Link>
          {item.category && (
            <>
              <span>/</span>
              <Link
                href={`/resources/${collection.slug}?category=${item.category.slug}`}
                className="hover:text-white/60 transition-colors"
              >
                {item.category.name}
              </Link>
            </>
          )}
          <span>/</span>
          <span className="text-white/70">{item.title}</span>
        </div>

        {/* Back link */}
        <Link
          href={`/resources/${collection.slug}`}
          className="inline-flex items-center gap-1 text-white/60 hover:text-white text-sm mb-6 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
          Back to {collection.name}
        </Link>

        {/* Featured image */}
        {item.featured_image_url && (
          <div className="aspect-[16/9] overflow-hidden rounded-xl mb-8">
            <img
              src={item.featured_image_url}
              alt={item.title}
              className="w-full h-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          </div>
        )}

        {/* Header */}
        <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">{item.title}</h1>
        {item.subtitle && (
          <p className="text-white/60 text-lg mb-4">{item.subtitle}</p>
        )}
        {item.external_url && (
          <a
            href={item.external_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 text-sm mb-6 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            {item.external_url}
          </a>
        )}

        {/* Table of contents */}
        {item.sections.length > 1 && (
          <nav className="bg-white/5 border border-white/10 rounded-xl p-4 mb-8">
            <h2 className="text-sm font-medium text-white/70 mb-2">Contents</h2>
            <ul className="space-y-1">
              {item.sections.map((section) => (
                <li key={section.id}>
                  <a
                    href={`#${section.heading.toLowerCase().replace(/\s+/g, '-')}`}
                    className="text-sm text-white/50 hover:text-white transition-colors"
                  >
                    {section.heading}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}

        {/* Sections */}
        <div className="space-y-8">
          {item.sections.map((section) => (
            <div key={section.id} id={section.heading.toLowerCase().replace(/\s+/g, '-')}>
              <h2 className="text-xl font-semibold text-white mb-4">{section.heading}</h2>
              {section.content && (
                <article
                  className="prose prose-invert prose-lg max-w-none
                             prose-headings:text-white prose-p:text-white/80
                             prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
                             prose-strong:text-white prose-code:text-white/90
                             prose-li:text-white/80 prose-ul:text-white/80"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(section.content) }}
                />
              )}
            </div>
          ))}
        </div>

        {/* Previous/Next navigation */}
        {(prevItem || nextItem) && (
          <div className="flex items-center justify-between mt-12 pt-8 border-t border-white/10">
            {prevItem ? (
              <Link
                href={`/resources/${collection.slug}/${prevItem.slug}`}
                className="group flex items-center gap-2 text-white/60 hover:text-white transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m15 18-6-6 6-6" />
                </svg>
                <div className="text-right">
                  <div className="text-xs text-white/40">Previous</div>
                  <div className="text-sm">{prevItem.title}</div>
                </div>
              </Link>
            ) : <div />}
            {nextItem ? (
              <Link
                href={`/resources/${collection.slug}/${nextItem.slug}`}
                className="group flex items-center gap-2 text-white/60 hover:text-white transition-colors text-right"
              >
                <div>
                  <div className="text-xs text-white/40">Next</div>
                  <div className="text-sm">{nextItem.title}</div>
                </div>
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </Link>
            ) : <div />}
          </div>
        )}
      </div>
    </main>
  )
}
