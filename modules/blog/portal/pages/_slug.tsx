// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { createClient } from '@supabase/supabase-js'
import { notFound } from 'next/navigation'
import Link from 'next/link'

interface BlogPost {
  id: string
  title: string
  slug: string
  excerpt: string | null
  content: string
  featured_image: string | null
  featured_image_alt: string | null
  published_at: string | null
  reading_time: number | null
  category: {
    name: string
    slug: string
    color: string
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
      published_at, reading_time,
      category:blog_categories(name, slug, color),
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
    tags: (row.blog_post_tags ?? []).map((pt: any) => pt.tag).filter(Boolean),
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

  // White-label: portal workspace-shell `pub-*` article layout (two-column body + sticky sidebar),
  // token-driven so it inverts per brand UI mode. Renders inside the shell content area.
  return (
    <div className="pub-article-wrap pub-fade">
      <div className="pub-article-grid">
        <article className="pub-article-main">
          <h1>{post.title}</h1>
          <div className="pub-byline">
            {post.published_at && formatDate(post.published_at)}
            {post.reading_time ? ` · ${post.reading_time} min read` : ''}
          </div>
          {post.featured_image && (
            <div className="pub-cover lg">
              <img src={post.featured_image} alt={post.featured_image_alt || post.title} />
            </div>
          )}
          <div className="pub-body" dangerouslySetInnerHTML={{ __html: post.content }} />
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
