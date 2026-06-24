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

async function getSupabaseClient(authenticated: boolean) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) return null

  if (authenticated) {
    const cookieStore = await cookies()
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

  const cookieStore = await cookies()
  const supabase = createServerClient(url, key, {
    cookies: { get(name: string) { return cookieStore.get(name)?.value } },
  })
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

async function getCollectionData(slug: string, isAuthenticated: boolean) {
  // Use anon client for collection metadata (visible to all per RLS)
  const anonClient = await getSupabaseClient(false)
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
  const supabase = await getSupabaseClient(isAuthenticated)
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
    // If not authenticated, prompt to sign in
    if (!isAuthenticated) {
      return (
        <div className="pub-wrap pub-fade">
          <div className="pub-empty">
            <p style={{ marginBottom: 14 }}>You need to be signed in to view this resource.</p>
            <Link href="/sign-in" className="pub-link" style={{ color: 'var(--accent)' }}>Sign in →</Link>
          </div>
        </div>
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
    <div className="pub-wrap pub-fade">
      <style>{`
        .res-grid { display: grid; grid-template-columns: 240px minmax(0,1fr); gap: 40px; align-items: start; margin-top: 24px; }
        .res-nav-link { display: block; text-decoration: none; padding: 6px 10px; border-radius: 8px; font-size: 14px; color: var(--ink-3); transition: background .15s ease, color .15s ease; }
        .res-nav-link:hover { background: rgba(var(--ui-text), 0.06); color: var(--ink); }
        .res-nav-link[aria-current="page"] { background: rgba(var(--ui-text), 0.10); color: var(--ink); font-weight: 600; }
        .res-search { width: 100%; height: 38px; padding: 0 12px; border-radius: 10px; background: var(--paper); border: 1px solid var(--line); color: var(--ink); font-size: 14px; box-sizing: border-box; }
        .res-search::placeholder { color: var(--ink-4); }
        .res-cat-side { position: sticky; top: 96px; }
        @media (max-width: 760px) { .res-grid { grid-template-columns: 1fr; gap: 24px; } .res-cat-side { position: static; } }
      `}</style>

      <div className="pub-h">
        <div className="pub-byline" style={{ marginBottom: 10 }}>
          <Link href="/resources" style={{ color: 'var(--ink-4)', textDecoration: 'none' }}>Resources</Link>
          <span>/</span>
          <span style={{ color: 'var(--ink-3)' }}>{collection.name}</span>
        </div>
        <h1 style={{ margin: 0 }}>{collection.name}</h1>
        {collection.description && <p>{collection.description}</p>}
      </div>

      <div className="res-grid">
        {/* Sidebar — search + category filter */}
        <aside className="res-cat-side">
          <form style={{ marginBottom: 16 }}>
            <input type="text" name="q" defaultValue={searchQuery} placeholder="Search items…" className="res-search" />
          </form>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Link href={`/resources/${collection.slug}`} aria-current={!activeCategory ? 'page' : undefined} className="res-nav-link">
              All ({items.length})
            </Link>
            {categories.map((cat) => {
              const count = items.filter(i => i.category_id === cat.id).length
              return (
                <Link
                  key={cat.id}
                  href={`/resources/${collection.slug}?category=${cat.slug}`}
                  aria-current={activeCategory === cat.slug ? 'page' : undefined}
                  className="res-nav-link"
                >
                  {cat.name} ({count})
                </Link>
              )
            })}
          </nav>
        </aside>

        {/* Content */}
        <div style={{ minWidth: 0 }}>
          {filteredItems.length === 0 ? (
            <div className="pub-empty" style={{ marginTop: 0 }}>No items found.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
              {categories
                .filter(cat => itemsByCategory.has(cat.id))
                .map((cat) => (
                  <section key={cat.id}>
                    <h2 style={{ font: '600 22px var(--font-display)', color: 'var(--ink)', letterSpacing: '-0.01em', margin: '0 0 4px' }}>{cat.name}</h2>
                    {cat.description && <p style={{ color: 'var(--ink-3)', fontSize: 14, margin: '0 0 14px' }}>{cat.description}</p>}
                    <div className="pub-grid" style={{ marginTop: cat.description ? 0 : 14, gridTemplateColumns: 'repeat(2, 1fr)' }}>
                      {(itemsByCategory.get(cat.id) || []).map((item) => (
                        <Link key={item.id} href={`/resources/${collection.slug}/${item.slug}`} className="pub-card">
                          <div className="pub-cover">
                            {item.featured_image_url && (
                              <img src={item.featured_image_url} alt={item.title} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                            )}
                          </div>
                          <div className="pub-card-body">
                            <h3>{item.title}</h3>
                            {item.subtitle && <p>{item.subtitle}</p>}
                          </div>
                        </Link>
                      ))}
                    </div>
                  </section>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
