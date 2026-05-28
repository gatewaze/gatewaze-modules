// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { notFound } from 'next/navigation'
import Link from 'next/link'

interface Collection {
  id: string
  name: string
  slug: string
  description: string | null
  access: string
}

interface Category {
  id: string
  name: string
  slug: string
  description: string | null
  icon: string | null
}

interface Item {
  id: string
  title: string
  slug: string
  subtitle: string | null
  external_url: string | null
  featured_image_url: string | null
  category_id: string
}

function getSupabaseClient(authenticated: boolean) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) return null

  if (authenticated) {
    const cookieStore = cookies()
    return createServerClient(url, key, {
      cookies: { get(name: string) { return cookieStore.get(name)?.value } },
    })
  }

  return createClient(url, key, {
    global: { fetch: (url, options = {}) => fetch(url, { ...options, cache: 'no-store' }) },
  })
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

async function getCollectionData(slug: string, isAuthenticated: boolean) {
  // Use anon client for collection metadata (visible to all per RLS)
  const anonClient = getSupabaseClient(false)
  if (!anonClient) return null

  const { data: collection, error: colError } = await anonClient
    .from('sr_collections')
    .select('id, name, slug, description, access')
    .eq('slug', slug)
    .eq('status', 'published')
    .single()

  if (colError || !collection) return null

  // Check access
  const effectiveAccess = collection.access === 'public' ? 'public' : 'authenticated'
  if (effectiveAccess === 'authenticated' && !isAuthenticated) return null

  // Use authenticated client for content (handles inherit collections where anon RLS blocks)
  const supabase = getSupabaseClient(isAuthenticated)
  if (!supabase) return null

  const { data: categories } = await supabase
    .from('sr_categories')
    .select('id, name, slug, description, icon')
    .eq('collection_id', collection.id)
    .order('sort_order', { ascending: true })

  const { data: items } = await supabase
    .from('sr_items')
    .select('id, title, slug, subtitle, external_url, featured_image_url, category_id')
    .eq('collection_id', collection.id)
    .eq('status', 'published')
    .order('sort_order', { ascending: true })

  return {
    collection: collection as Collection,
    categories: (categories || []) as Category[],
    items: (items || []) as Item[],
  }
}

interface Props {
  params: { collectionSlug: string }
  searchParams: { category?: string; q?: string }
}

export default async function CollectionDetailPage({ params, searchParams }: Props) {
  const session = await getSession()
  const isAuthenticated = !!session

  const data = await getCollectionData(params.collectionSlug, isAuthenticated)

  if (!data) {
    // If not authenticated, redirect to sign-in
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

  const { collection, categories, items } = data
  const activeCategory = searchParams.category || ''
  const searchQuery = searchParams.q || ''

  // Filter items
  let filteredItems = items
  if (activeCategory) {
    filteredItems = filteredItems.filter(i => {
      const cat = categories.find(c => c.id === i.category_id)
      return cat?.slug === activeCategory
    })
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase()
    filteredItems = filteredItems.filter(i =>
      i.title.toLowerCase().includes(q) || i.subtitle?.toLowerCase().includes(q)
    )
  }

  // Group items by category
  const itemsByCategory = new Map<string, Item[]>()
  for (const item of filteredItems) {
    const catItems = itemsByCategory.get(item.category_id) || []
    catItems.push(item)
    itemsByCategory.set(item.category_id, catItems)
  }

  return (
    <main className="relative z-10">
      <div className="max-w-7xl mx-auto px-6 sm:px-6 lg:px-8 py-8 sm:py-12">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-white/40 mb-6">
          <Link href="/resources" className="hover:text-white/60 transition-colors">Resources</Link>
          <span>/</span>
          <span className="text-white/70">{collection.name}</span>
        </div>

        {/* Header */}
        <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">{collection.name}</h1>
        {collection.description && (
          <p className="text-white/60 text-lg mb-8 max-w-3xl">{collection.description}</p>
        )}

        <div className="flex flex-col lg:flex-row gap-8">
          {/* Sidebar */}
          <div className="lg:w-64 flex-shrink-0">
            {/* Search */}
            <form className="mb-6">
              <input
                type="text"
                name="q"
                defaultValue={searchQuery}
                placeholder="Search items..."
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder:text-white/30 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </form>

            {/* Category filter */}
            <nav className="space-y-1">
              <Link
                href={`/resources/${collection.slug}`}
                className={`block px-3 py-2 rounded-lg text-sm transition-colors ${!activeCategory ? 'bg-white/10 text-white' : 'text-white/60 hover:text-white hover:bg-white/5'}`}
              >
                All ({items.length})
              </Link>
              {categories.map(cat => {
                const count = items.filter(i => i.category_id === cat.id).length
                return (
                  <Link
                    key={cat.id}
                    href={`/resources/${collection.slug}?category=${cat.slug}`}
                    className={`block px-3 py-2 rounded-lg text-sm transition-colors ${activeCategory === cat.slug ? 'bg-white/10 text-white' : 'text-white/60 hover:text-white hover:bg-white/5'}`}
                  >
                    {cat.name} ({count})
                  </Link>
                )
              })}
            </nav>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {filteredItems.length === 0 ? (
              <p className="text-white/60 text-center py-12">No items found.</p>
            ) : (
              <div className="space-y-8">
                {categories
                  .filter(cat => itemsByCategory.has(cat.id))
                  .map(cat => (
                    <div key={cat.id}>
                      <h2 className="text-xl font-semibold text-white mb-4">{cat.name}</h2>
                      {cat.description && <p className="text-white/50 text-sm mb-4">{cat.description}</p>}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {(itemsByCategory.get(cat.id) || []).map(item => (
                          <Link
                            key={item.id}
                            href={`/resources/${collection.slug}/${item.slug}`}
                            className="group block"
                          >
                            <div className="bg-white/5 rounded-xl border border-white/10 overflow-hidden hover:bg-white/10 hover:border-white/20 transition-all duration-200">
                              {item.featured_image_url && (
                                <div className="aspect-[16/9] overflow-hidden">
                                  <img
                                    src={item.featured_image_url}
                                    alt={item.title}
                                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                                  />
                                </div>
                              )}
                              <div className="p-4">
                                <h3 className="text-white font-semibold group-hover:text-white/90 transition-colors">
                                  {item.title}
                                </h3>
                                {item.subtitle && (
                                  <p className="text-white/50 text-sm mt-1 line-clamp-2">{item.subtitle}</p>
                                )}
                                {item.external_url && (
                                  <span className="text-blue-400 text-xs mt-2 inline-block">{new URL(item.external_url).hostname}</span>
                                )}
                              </div>
                            </div>
                          </Link>
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
