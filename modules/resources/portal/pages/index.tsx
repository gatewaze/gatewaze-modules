// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import Link from 'next/link'
import { SafeImg } from '../components/SafeImg'

interface Collection {
  id: string
  name: string
  slug: string
  description: string | null
  cover_image_url: string | null
  access: 'public' | 'authenticated' | 'inherit' | 'metered'
  status: 'draft' | 'published' | 'archived'
}

async function getSession() {
  const cookieStore = await cookies()
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

async function getCollections(isAuthenticated: boolean): Promise<{ collections: Collection[]; isAdmin: boolean }> {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) return { collections: [], isAdmin: false }

  const cols = 'id, name, slug, description, cover_image_url, access, status'

  if (isAuthenticated) {
    // Use server client with cookies for authenticated access
    const cookieStore = await cookies()
    const supabase = createServerClient(url, key, {
      cookies: {
        get(name: string) { return cookieStore.get(name)?.value },
      },
    })

    // Admins may preview draft collections in place (RLS admin-preview policy);
    // everyone else is limited to published.
    const { data: adminData } = await supabase.rpc('is_admin')
    const isAdmin = adminData === true
    const statuses = isAdmin ? ['published', 'draft'] : ['published']

    const { data, error } = await supabase
      .from('sr_collections')
      .select(cols)
      .in('status', statuses)
      .order('sort_order', { ascending: true })

    if (error) {
      console.error('[resources] Failed to fetch collections:', error)
      return { collections: [], isAdmin }
    }
    return { collections: data || [], isAdmin }
  }

  // Anon client — can see all published collection metadata (for teaser)
  const supabase = createClient(url, key, {
    global: { fetch: (url, options = {}) => fetch(url, { ...options, cache: 'no-store' }) },
  })

  const { data, error } = await supabase
    .from('sr_collections')
    .select(cols)
    .eq('status', 'published')
    .order('sort_order', { ascending: true })

  if (error) {
    console.error('[resources] Failed to fetch collections:', error)
    return { collections: [], isAdmin: false }
  }
  return { collections: data || [], isAdmin: false }
}

// Resolve effective access: 'inherit' falls back to module config default
function resolveAccess(access: string): 'public' | 'authenticated' | 'metered' {
  if (access === 'public') return 'public'
  if (access === 'metered') return 'metered'
  if (access === 'authenticated') return 'authenticated'
  // 'inherit' — default to authenticated (safe default; module config resolved at app layer)
  return 'authenticated'
}

export default async function ResourcesListingPage() {
  const session = await getSession()
  const isAuthenticated = !!session
  const { collections, isAdmin } = await getCollections(isAuthenticated)

  const visibleCollections = collections.filter(c => {
    const effective = resolveAccess(c.access)
    if (effective === 'public') return true
    if (effective === 'authenticated' && isAuthenticated) return true
    // Show teaser for auth-gated collections (anon can see metadata via RLS)
    return true
  })

  return (
    <div className="pub-wrap pub-fade">
      <div className="pub-h">
        <h1>Resources</h1>
        <p>Guides, references, and curated collections.</p>
      </div>

      {visibleCollections.length === 0 ? (
        <div className="pub-empty">No resources available yet.</div>
      ) : (
        <div className="pub-grid">
          {visibleCollections.map((collection) => {
            const effective = resolveAccess(collection.access)
            const isGated = effective === 'authenticated' && !isAuthenticated

            const cover = (
              <div className={collection.cover_image_url ? 'pub-cover fit' : 'pub-cover'}>
                {collection.cover_image_url ? (
                  <SafeImg
                    src={collection.cover_image_url}
                    alt={collection.name}
                    style={isGated ? { filter: 'blur(4px)', opacity: 0.5 } : undefined}
                  />
                ) : (
                  <span className="pub-cover-ph">cover</span>
                )}
              </div>
            )

            if (isGated) {
              return (
                <div className="pub-card pub-card-flex" key={collection.id} style={{ cursor: 'default' }}>
                  {cover}
                  <div className="pub-card-body">
                    <span className="pub-side-h" style={{ marginBottom: 8, display: 'block' }}>🔒 Login required</span>
                    <h3>{collection.name}</h3>
                    {collection.description && <p>{collection.description}</p>}
                    <Link href="/sign-in" className="pub-link" style={{ color: 'var(--accent)', marginTop: 12, display: 'inline-block' }}>
                      Sign in to access →
                    </Link>
                  </div>
                </div>
              )
            }

            return (
              <Link href={`/resources/${collection.slug}`} className="pub-card pub-card-flex gw-card-glow" key={collection.id}>
                {cover}
                <div className="pub-card-body">
                  {isAdmin && collection.status === 'draft' && (
                    <span className="pub-side-h" style={{ marginBottom: 8, display: 'block', color: 'var(--warning-color)' }}>● Draft — admin preview</span>
                  )}
                  {effective === 'metered' && !isAuthenticated && (
                    <span className="pub-side-h" style={{ marginBottom: 8, display: 'block' }}>Members · free preview</span>
                  )}
                  <h3>{collection.name}</h3>
                  {collection.description && <p>{collection.description}</p>}
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
