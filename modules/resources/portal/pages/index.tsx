// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import Link from 'next/link'

interface Collection {
  id: string
  name: string
  slug: string
  description: string | null
  cover_image_url: string | null
  access: 'public' | 'authenticated' | 'inherit'
}

async function getSession() {
  const cookieStore = cookies()
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) return null

  const supabase = createServerClient(url, key, {
    cookies: {
      get(name: string) { return cookieStore.get(name)?.value },
    },
  })

  const { data: { session } } = await supabase.auth.getSession()
  return session
}

async function getCollections(isAuthenticated: boolean): Promise<Collection[]> {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) return []

  if (isAuthenticated) {
    // Use server client with cookies for authenticated access
    const cookieStore = cookies()
    const supabase = createServerClient(url, key, {
      cookies: {
        get(name: string) { return cookieStore.get(name)?.value },
      },
    })

    const { data, error } = await supabase
      .from('sr_collections')
      .select('id, name, slug, description, cover_image_url, access')
      .eq('status', 'published')
      .order('sort_order', { ascending: true })

    if (error) {
      console.error('[structured-resources] Failed to fetch collections:', error)
      return []
    }
    return data || []
  } else {
    // Anon client — can see all published collection metadata (for teaser)
    const supabase = createClient(url, key, {
      global: { fetch: (url, options = {}) => fetch(url, { ...options, cache: 'no-store' }) },
    })

    const { data, error } = await supabase
      .from('sr_collections')
      .select('id, name, slug, description, cover_image_url, access')
      .eq('status', 'published')
      .order('sort_order', { ascending: true })

    if (error) {
      console.error('[structured-resources] Failed to fetch collections:', error)
      return []
    }
    return data || []
  }
}

// Resolve effective access: 'inherit' falls back to module config default
function resolveAccess(access: string): 'public' | 'authenticated' {
  if (access === 'public') return 'public'
  if (access === 'authenticated') return 'authenticated'
  // 'inherit' — default to authenticated (safe default; module config resolved at app layer)
  return 'authenticated'
}

export default async function ResourcesListingPage() {
  const session = await getSession()
  const isAuthenticated = !!session
  const collections = await getCollections(isAuthenticated)

  const visibleCollections = collections.filter(c => {
    const effective = resolveAccess(c.access)
    if (effective === 'public') return true
    if (effective === 'authenticated' && isAuthenticated) return true
    // Show teaser for auth-gated collections (anon can see metadata via RLS)
    return true
  })

  return (
    <main className="relative z-10">
      <div className="max-w-7xl mx-auto px-6 sm:px-6 lg:px-8 py-8 sm:py-12">
        <h1 className="text-3xl sm:text-4xl font-bold text-white mb-8">Resources</h1>

        {visibleCollections.length === 0 ? (
          <p className="text-white/60 text-center py-12">No resources available yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {visibleCollections.map((collection) => {
              const effective = resolveAccess(collection.access)
              const isGated = effective === 'authenticated' && !isAuthenticated

              return (
                <div key={collection.id} className="relative">
                  {isGated ? (
                    <div className="group block">
                      <div className="relative bg-white/5 rounded-xl border border-white/10 overflow-hidden">
                        {collection.cover_image_url && (
                          <div className="aspect-[16/9] overflow-hidden">
                            <img
                              src={collection.cover_image_url}
                              alt={collection.name}
                              className="w-full h-full object-cover blur-sm opacity-50"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                            />
                          </div>
                        )}
                        <div className="p-4">
                          <div className="flex items-center gap-2 mb-2">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/40">
                              <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                            </svg>
                            <span className="text-xs text-white/40">Login required</span>
                          </div>
                          <h2 className="text-white font-semibold text-base">{collection.name}</h2>
                          {collection.description && (
                            <p className="text-white/40 text-sm mt-2 line-clamp-2">{collection.description}</p>
                          )}
                          <Link
                            href="/sign-in"
                            className="inline-block mt-4 text-sm text-blue-400 hover:text-blue-300 transition-colors"
                          >
                            Sign in to access →
                          </Link>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <Link href={`/resources/${collection.slug}`} className="group block">
                      <div className="relative bg-white/5 rounded-xl border border-white/10 overflow-hidden hover:bg-white/10 hover:border-white/20 transition-all duration-200">
                        {collection.cover_image_url && (
                          <div className="aspect-[16/9] overflow-hidden">
                            <img
                              src={collection.cover_image_url}
                              alt={collection.name}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                            />
                          </div>
                        )}
                        <div className="p-4">
                          <h2 className="text-white font-semibold text-base group-hover:text-white/90 transition-colors">
                            {collection.name}
                          </h2>
                          {collection.description && (
                            <p className="text-white/60 text-sm mt-2 line-clamp-2">{collection.description}</p>
                          )}
                        </div>
                      </div>
                    </Link>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </main>
  )
}
