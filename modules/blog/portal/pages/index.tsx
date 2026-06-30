// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { createClient } from '@supabase/supabase-js'
import { headers } from 'next/headers'
import Link from 'next/link'

interface BlogPost {
  id: string
  title: string
  slug: string
  excerpt: string | null
  featured_image: string | null
  featured_image_alt: string | null
  published_at: string | null
  reading_time: number | null
  category: {
    name: string
    slug: string
    color: string
  } | null
}

async function getBlogPosts(): Promise<BlogPost[]> {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) return []

  const supabase = createClient(url, key, {
    global: { fetch: (url, options = {}) => fetch(url, { ...options, cache: 'no-store' }) },
  })

  const { data, error } = await supabase
    .from('blog_posts')
    .select(`
      id, title, slug, excerpt, featured_image, featured_image_alt,
      published_at, reading_time,
      category:blog_categories(name, slug, color)
    `)
    .eq('status', 'published')
    .eq('visibility', 'public')
    .order('published_at', { ascending: false })

  if (error) {
    console.error('[blog-portal] Failed to fetch posts:', error)
    return []
  }

  return (data ?? []).map((row: any) => ({
    ...row,
    category: Array.isArray(row.category) ? row.category[0] ?? null : row.category,
  }))
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export default async function BlogListingPage() {
  const posts = await getBlogPosts()

  const reqHeaders = await headers()
  const host = reqHeaders.get('x-forwarded-host') || reqHeaders.get('host') || ''
  const proto = reqHeaders.get('x-forwarded-proto') || 'https'
  const base = host ? `${proto}://${host}` : ''
  const blogUrl = `${base}/blog`
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Blog',
        '@id': `${blogUrl}#blog`,
        url: blogUrl,
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: posts.length,
          itemListElement: posts.map((p, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            url: `${blogUrl}/${p.slug}`,
            name: p.title,
          })),
        },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Blog', item: blogUrl }],
      },
    ],
  }

  // White-label: uses the portal workspace-shell `pub-*` design system (token-driven, inverts per
  // brand UI mode) instead of hard-coded white-on-dark. Renders inside the shell content area.
  return (
    <div className="pub-wrap pub-fade">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="pub-h">
        <h1>Blog</h1>
        <p>Field notes, updates and stories from the community.</p>
      </div>

      {posts.length === 0 ? (
        <div className="pub-empty">No posts published yet.</div>
      ) : (
        <div className="pub-grid">
          {posts.map((post) => (
            <Link key={post.id} href={`/blog/${post.slug}`} className="pub-card gw-card-glow">
              <div className="pub-cover">
                {post.featured_image ? (
                  <img src={post.featured_image} alt={post.featured_image_alt || post.title} />
                ) : (
                  <span className="pub-cover-ph">cover</span>
                )}
              </div>
              <div className="pub-card-body">
                {post.category && (
                  <span className="pub-cat" style={post.category.color ? { color: post.category.color } : undefined}>
                    {post.category.name}
                  </span>
                )}
                <h3>{post.title}</h3>
                {post.excerpt && <p>{post.excerpt}</p>}
                <div className="pub-meta">
                  {post.published_at && formatDate(post.published_at)}
                  {post.reading_time ? (
                    <>
                      <span className="dotsep" />
                      {post.reading_time} min read
                    </>
                  ) : null}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
