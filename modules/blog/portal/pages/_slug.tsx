// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { createClient } from '@supabase/supabase-js'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { convert } from 'html-to-text'

interface BlogPost {
  id: string
  title: string
  slug: string
  excerpt: string | null
  content: string
  featured_image: string | null
  featured_image_alt: string | null
  published_at: string | null
  updated_at: string | null
  reading_time: number | null
  word_count: number | null
  is_external: boolean | null
  canonical_url: string | null
  category: {
    name: string
    slug: string
    color: string
  } | null
  author: {
    slug: string
    display_name: string
    avatar_url: string | null
  } | null
  tags: { name: string; slug: string }[]
}

async function getBlogPost(slug: string): Promise<BlogPost | null> {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) return null

  const supabase = createClient(url, key, {
    global: { fetch: (url, options = {}) => fetch(url, { ...options, cache: 'no-store' }) },
  })

  const { data, error } = await supabase
    .from('blog_posts')
    .select(`
      id, title, slug, excerpt, content, featured_image, featured_image_alt,
      published_at, updated_at, reading_time, word_count, is_external, canonical_url,
      category:blog_categories(name, slug, color),
      author:blog_authors(slug, display_name, avatar_url),
      blog_post_tags(tag:blog_tags(name, slug))
    `)
    .eq('slug', slug)
    .eq('status', 'published')
    .eq('visibility', 'public')
    .single()

  if (error || !data) return null

  const row = data as any

  // Increment view count (fire and forget)
  supabase.rpc('increment_post_views', { post_id: row.id }).then(() => {})

  return {
    ...row,
    category: Array.isArray(row.category) ? row.category[0] ?? null : row.category,
    author: Array.isArray(row.author) ? row.author[0] ?? null : row.author,
    tags: (row.blog_post_tags ?? []).map((pt: any) => pt.tag).filter(Boolean),
  }
}

function hostLabel(url: string | null): string {
  if (!url) return 'the original site'
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'the original site'
  }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

interface Props {
  params: { slug: string }
}

export default async function BlogDetailPage({ params }: Props) {
  const slug = params.slug
  if (!slug) notFound()

  const post = await getBlogPost(slug)
  if (!post) notFound()

  // Absolute base from the serving host (per-tenant canonical, incl. custom domains).
  const reqHeaders = await headers()
  const host = reqHeaders.get('x-forwarded-host') || reqHeaders.get('host') || ''
  const proto = reqHeaders.get('x-forwarded-proto') || 'https'
  const base = host ? `${proto}://${host}` : ''
  const pageUrl = `${base}/blog/${post.slug}`
  const isExternal = !!(post.is_external && post.canonical_url)
  // The full body is stored for agents even when it's hidden from the human
  // portal (external posts link out). articleBody carries it into the JSON-LD.
  const articleBody = post.content
    ? convert(post.content, { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }] }).trim()
    : ''
  // Canonical attribution: external posts point search engines / agents at the
  // source (anti-cloaking — an additive representation, never a bot-only swap).
  const canonicalTarget = isExternal ? (post.canonical_url as string) : pageUrl
  const authorUrl = post.author ? `${base}/blog/author/${post.author.slug}` : null

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        '@id': `${pageUrl}#post`,
        headline: post.title,
        ...(post.excerpt ? { description: post.excerpt } : {}),
        ...(post.featured_image ? { image: post.featured_image } : {}),
        ...(articleBody ? { articleBody } : {}),
        ...(post.published_at ? { datePublished: post.published_at } : {}),
        ...(post.updated_at ? { dateModified: post.updated_at } : {}),
        ...(post.word_count ? { wordCount: post.word_count } : {}),
        ...(post.category?.name ? { articleSection: post.category.name } : {}),
        ...(post.tags.length ? { keywords: post.tags.map((t) => t.name).join(', ') } : {}),
        ...(post.author && authorUrl
          ? { author: { '@type': 'Person', name: post.author.display_name, url: authorUrl } }
          : {}),
        ...(isExternal ? { sameAs: post.canonical_url } : {}),
        mainEntityOfPage: canonicalTarget,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Blog', item: `${base}/blog` },
          { '@type': 'ListItem', position: 2, name: post.title, item: pageUrl },
        ],
      },
    ],
  }

  // White-label: portal workspace-shell `pub-*` article layout (two-column body + sticky sidebar),
  // token-driven so it inverts per brand UI mode. Renders inside the shell content area.
  return (
    <div className="pub-article-wrap pub-fade">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="pub-article-grid">
        <article className="pub-article-main">
          <h1>{post.title}</h1>
          <div className="pub-byline">
            {post.author && (
              <>
                <Link href={`/blog/author/${post.author.slug}`} className="pub-author-link">
                  {post.author.display_name}
                </Link>
                {' · '}
              </>
            )}
            {post.published_at && formatDate(post.published_at)}
            {post.reading_time ? ` · ${post.reading_time} min read` : ''}
          </div>
          {post.featured_image && (
            <div className="pub-cover lg">
              <img src={post.featured_image} alt={post.featured_image_alt || post.title} />
            </div>
          )}
          {isExternal ? (
            // Syndicated post: the human view links out to the source (canonical
            // attribution). The full body is stored + exposed to agents via the
            // JSON-LD articleBody above, but not re-hosted for human readers.
            <div className="pub-external-cta">
              {post.excerpt && <p className="pub-lede">{post.excerpt}</p>}
              <a className="pub-btn" href={post.canonical_url as string} target="_blank" rel="noopener noreferrer">
                Read the full article on {hostLabel(post.canonical_url)} →
              </a>
            </div>
          ) : (
            <div className="pub-body" dangerouslySetInnerHTML={{ __html: post.content }} />
          )}
        </article>

        <aside className="pub-article-side">
          {post.category && (
            <div className="pub-side-card">
              <div className="pub-side-h">Category</div>
              <span className="pub-cat" style={post.category.color ? { color: post.category.color } : undefined}>
                {post.category.name}
              </span>
            </div>
          )}
          <div className="pub-side-card">
            <div className="pub-side-h">Published</div>
            <div className="pub-side-val">{post.published_at && formatDate(post.published_at)}</div>
            {post.reading_time ? <div className="pub-side-sub">{post.reading_time} min read</div> : null}
          </div>
          {post.tags.length > 0 && (
            <div className="pub-side-card">
              <div className="pub-side-h">Tags</div>
              <div className="pub-tags">
                {post.tags.map((tag) => (
                  <span key={tag.slug} className="pub-tag">{tag.name}</span>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
