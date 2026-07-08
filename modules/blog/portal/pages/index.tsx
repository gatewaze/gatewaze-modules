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
  is_external: boolean | null
  canonical_url: string | null
  content_category: string | null
  category: {
    name: string
    slug: string
    color: string
  } | null
}

interface ContentCategoryOption {
  value: string
  label: string
}

/**
 * Brand-configured content categories (Settings → Content categories in the
 * admin UI, platform_settings.content_categories). Array order = display
 * priority, so the /blog sections render in exactly that order
 * (e.g. Foundation → Member → Community).
 */
async function getContentCategories(supabase: any): Promise<ContentCategoryOption[]> {
  const { data } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'content_categories')
    .maybeSingle()
  if (!data?.value) return []
  try {
    const parsed = JSON.parse(data.value)
    return Array.isArray(parsed) ? parsed.filter((c: any) => c?.value && c?.label) : []
  } catch {
    return []
  }
}

async function getBlogData(): Promise<{ posts: BlogPost[]; categories: ContentCategoryOption[] }> {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) return { posts: [], categories: [] }

  const supabase = createClient(url, key, {
    global: { fetch: (url, options = {}) => fetch(url, { ...options, cache: 'no-store' }) },
  })

  const [{ data, error }, categories] = await Promise.all([
    supabase
      .from('blog_posts')
      .select(`
        id, title, slug, excerpt, featured_image, featured_image_alt,
        published_at, reading_time, is_external, canonical_url, content_category,
        category:blog_categories(name, slug, color)
      `)
      .eq('status', 'published')
      .eq('visibility', 'public')
      .order('published_at', { ascending: false }),
    getContentCategories(supabase),
  ])

  if (error) {
    console.error('[blog-portal] Failed to fetch posts:', error)
    return { posts: [], categories }
  }

  const posts = (data ?? []).map((row: any) => ({
    ...row,
    category: Array.isArray(row.category) ? row.category[0] ?? null : row.category,
  }))
  return { posts, categories }
}

/**
 * Group posts by content category, sections ordered per the configured
 * category priority; posts with no/unknown category trail in one last group.
 */
function groupByContentCategory(posts: BlogPost[], categories: ContentCategoryOption[]) {
  const groups: { key: string; label: string | null; posts: BlogPost[] }[] = categories.map((c) => ({
    key: c.value,
    label: c.label,
    posts: posts.filter((p) => p.content_category === c.value),
  }))
  const known = new Set(categories.map((c) => c.value))
  const rest = posts.filter((p) => !p.content_category || !known.has(p.content_category))
  if (rest.length > 0) {
    // Label the trailing group only when there are labelled sections above it.
    groups.push({ key: '__other', label: groups.some((g) => g.posts.length > 0) ? 'More' : null, posts: rest })
  }
  return groups.filter((g) => g.posts.length > 0)
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function categoryLabel(value: string | null, categories: ContentCategoryOption[]): string | null {
  if (!value) return null
  return categories.find((c) => c.value === value)?.label ?? value
}

function BlogPostCard({ post, categories }: { post: BlogPost; categories: ContentCategoryOption[] }) {
  // Scraped/syndicated posts (e.g. the AAIF blog) live off-site — link
  // the card straight out to canonical_url in a new tab instead of the
  // internal /blog/<slug> page (which has no body for external posts).
  const isExternal = post.is_external && post.canonical_url
  const CardTag: any = isExternal ? 'a' : Link
  const cardProps = isExternal
    ? { href: post.canonical_url as string, target: '_blank', rel: 'noopener noreferrer' }
    : { href: `/blog/${post.slug}` }
  const pill = categoryLabel(post.content_category, categories)
  return (
    <CardTag {...cardProps} className="pub-card pub-card-flex gw-card-glow">
      {/* natural: show the whole cover at its own aspect ratio (no crop).
          Placeholders keep the default fixed aspect so they don't collapse. */}
      <div className={post.featured_image ? 'pub-cover natural' : 'pub-cover'}>
        {post.featured_image ? (
          <img src={post.featured_image} alt={post.featured_image_alt || post.title} />
        ) : (
          <span className="pub-cover-ph">cover</span>
        )}
      </div>
      <div className="pub-card-body">
        {pill && <span className="pub-cat">{pill}</span>}
        {post.category && (
          <span className="pub-cat" style={post.category.color ? { color: post.category.color } : undefined}>
            {post.category.name}
          </span>
        )}
        <h3>{post.title}</h3>
        {post.excerpt && <p>{post.excerpt}</p>}
        <div className="pub-meta pub-meta-pin">
          {post.published_at && formatDate(post.published_at)}
          {post.reading_time ? (
            <>
              <span className="dotsep" />
              {post.reading_time} min read
            </>
          ) : null}
        </div>
      </div>
    </CardTag>
  )
}

export default async function BlogListingPage() {
  const { posts, categories } = await getBlogData()
  const sections = groupByContentCategory(posts, categories)

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
        sections.map((section) => (
          <section key={section.key} className="pub-typesec">
            {section.label && <h2 className="pub-typesec-h">{section.label}</h2>}
            <div className="pub-grid">
              {section.posts.map((post) => (
                <BlogPostCard key={post.id} post={post} categories={categories} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
