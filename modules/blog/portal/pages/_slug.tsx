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
  params: { path: string[] }
}

export default async function BlogDetailPage({ params }: Props) {
  // path = ['blog', 'the-slug'] — the slug is the second segment
  const slug = params.path[1]
  if (!slug) notFound()

  const post = await getBlogPost(slug)
  if (!post) notFound()

  return (
    <main className="relative z-10">
      <div className="max-w-3xl mx-auto px-6 sm:px-6 lg:px-8 py-8 sm:py-12">
        <Link
          href="/blog"
          className="inline-flex items-center gap-1 text-white/60 hover:text-white text-sm mb-6 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
          Back to Blog
        </Link>

        {post.featured_image && (
          <div className="aspect-[16/9] overflow-hidden rounded-xl mb-8">
            <img
              src={post.featured_image}
              alt={post.featured_image_alt || post.title}
              className="w-full h-full object-cover"
            />
          </div>
        )}

        <div className="flex items-center gap-3 mb-4">
          {post.category && (
            <span
              className="inline-block text-xs font-medium px-2 py-0.5 rounded-full"
              style={{ backgroundColor: post.category.color + '33', color: post.category.color }}
            >
              {post.category.name}
            </span>
          )}
          <div className="flex items-center gap-3 text-white/40 text-xs">
            {post.published_at && <span>{formatDate(post.published_at)}</span>}
            {post.reading_time && <span>{post.reading_time} min read</span>}
          </div>
        </div>

        <h1 className="text-3xl sm:text-4xl font-bold text-white mb-6">{post.title}</h1>

        {post.tags.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-8">
            {post.tags.map((tag) => (
              <span
                key={tag.slug}
                className="text-xs text-white/50 bg-white/5 border border-white/10 px-2 py-0.5 rounded-full"
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}

        <article
          className="prose prose-invert prose-lg max-w-none
                     prose-headings:text-white prose-p:text-white/80
                     prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
                     prose-strong:text-white prose-code:text-white/90
                     prose-img:rounded-xl"
          dangerouslySetInnerHTML={{ __html: post.content }}
        />
      </div>
    </main>
  )
}
