// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { createClient } from '@supabase/supabase-js'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import Link from 'next/link'

interface Author {
  id: string
  slug: string
  display_name: string
  avatar_url: string | null
  bio: string | null
}

interface AuthorPost {
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
}

function client() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key, {
    global: { fetch: (u, options = {}) => fetch(u, { ...options, cache: 'no-store' }) },
  })
}

async function getAuthorData(slug: string): Promise<{ author: Author; posts: AuthorPost[] } | null> {
  const supabase = client()
  if (!supabase) return null

  // NB: selects blog_authors only (never public.people) — synthetic author
  // emails must never reach a public surface.
  const { data: author } = await supabase
    .from('blog_authors')
    .select('id, slug, display_name, avatar_url, bio')
    .eq('slug', slug)
    .maybeSingle()
  if (!author) return null

  const { data: posts } = await supabase
    .from('blog_posts')
    .select('id, title, slug, excerpt, featured_image, featured_image_alt, published_at, reading_time, is_external, canonical_url')
    .eq('blog_author_id', author.id)
    .eq('status', 'published')
    .eq('visibility', 'public')
    .order('published_at', { ascending: false })

  return { author, posts: posts ?? [] }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

function initials(name: string): string {
  return (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')
}

function AuthorCard({ post }: { post: AuthorPost }) {
  const isExternal = post.is_external && post.canonical_url
  const LinkTag: any = isExternal ? 'a' : Link
  const linkProps = isExternal
    ? { href: post.canonical_url as string, target: '_blank', rel: 'noopener noreferrer' }
    : { href: `/blog/${post.slug}` }
  return (
    <article className="pub-card pub-card-flex gw-card-glow">
      <LinkTag {...linkProps} className={post.featured_image ? 'pub-cover fit' : 'pub-cover'}>
        {post.featured_image ? (
          <img src={post.featured_image} alt={post.featured_image_alt || post.title} />
        ) : (
          <span className="pub-cover-ph">cover</span>
        )}
      </LinkTag>
      <div className="pub-card-body">
        <h3>
          <LinkTag {...linkProps} className="pub-card-title-link">{post.title}</LinkTag>
        </h3>
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
    </article>
  )
}

interface Props {
  params: { slug: string }
}

export default async function BlogAuthorPage({ params }: Props) {
  const slug = params.slug
  if (!slug) notFound()

  const data = await getAuthorData(slug)
  if (!data) notFound()
  const { author, posts } = data

  const reqHeaders = await headers()
  const host = reqHeaders.get('x-forwarded-host') || reqHeaders.get('host') || ''
  const proto = reqHeaders.get('x-forwarded-proto') || 'https'
  const base = host ? `${proto}://${host}` : ''
  const authorUrl = `${base}/blog/author/${author.slug}`

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Person',
        '@id': `${authorUrl}#person`,
        name: author.display_name,
        url: authorUrl,
        ...(author.avatar_url ? { image: author.avatar_url } : {}),
        ...(author.bio ? { description: author.bio } : {}),
      },
      {
        '@type': 'ItemList',
        numberOfItems: posts.length,
        itemListElement: posts.map((p, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: p.is_external && p.canonical_url ? p.canonical_url : `${base}/blog/${p.slug}`,
          name: p.title,
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Blog', item: `${base}/blog` },
          { '@type': 'ListItem', position: 2, name: author.display_name, item: authorUrl },
        ],
      },
    ],
  }

  return (
    <div className="pub-wrap pub-fade">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="pub-h pub-author-h">
        <div className="pub-author-hero">
          {author.avatar_url ? (
            <img className="pub-author-hero-avatar" src={author.avatar_url} alt={author.display_name} />
          ) : (
            <span className="pub-author-hero-avatar pub-author-avatar-ph" aria-hidden>
              {initials(author.display_name)}
            </span>
          )}
          <div>
            <h1>{author.display_name}</h1>
            {author.bio && <p className="pub-author-bio">{author.bio}</p>}
            <div className="pub-author-count">
              {posts.length} {posts.length === 1 ? 'article' : 'articles'}
            </div>
          </div>
        </div>
        <Link href="/blog" className="pub-btn">← All posts</Link>
      </div>

      {posts.length === 0 ? (
        <div className="pub-empty">No published posts by this author yet.</div>
      ) : (
        <div className="pub-grid">
          {posts.map((post) => (
            <AuthorCard key={post.id} post={post} />
          ))}
        </div>
      )}
    </div>
  )
}
