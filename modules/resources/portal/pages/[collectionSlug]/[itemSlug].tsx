// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { cookies, headers } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { convert } from 'html-to-text'
import { SafeImg } from '../../components/SafeImg'

interface ItemData {
  id: string
  title: string
  slug: string
  subtitle: string | null
  external_url: string | null
  featured_image_url: string | null
  category: { id: string; name: string; slug: string } | null
  sections: { id: string; heading: string; content: string | null; sort_order: number }[]
}

interface CollectionData {
  id: string
  name: string
  slug: string
  access: string
}

interface NavItem {
  title: string
  slug: string
}

interface NavCategory {
  id: string
  name: string
  slug: string
}

interface NavArticle {
  id: string
  title: string
  slug: string
  category_id: string
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

async function getItemData(collectionSlug: string, itemSlug: string, isAuthenticated: boolean) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) return null

  const cookieStore = await cookies()
  const supabase = createServerClient(url, key, {
    cookies: { get(name: string) { return cookieStore.get(name)?.value } },
  })

  // Get collection
  const { data: collection } = await supabase
    .from('sr_collections')
    .select('id, name, slug, access')
    .eq('slug', collectionSlug)
    .eq('status', 'published')
    .single()

  if (!collection) return null

  // 'public' + 'metered' collections are readable by anon (RLS permits it); a
  // metered item is gated VISUALLY in the render (teaser + sign-in), while
  // crawlers/agents get the full text. 'authenticated'/'inherit' stay a hard
  // gate — only signed-in users may load them at all.
  if ((collection.access === 'authenticated' || collection.access === 'inherit') && !isAuthenticated) return null

  // Get item with sections
  const { data: item } = await supabase
    .from('sr_items')
    .select(`
      id, title, slug, subtitle, external_url, featured_image_url, updated_at, created_at,
      category:sr_categories(id, name, slug),
      sections:sr_sections(id, heading, content, sort_order)
    `)
    .eq('collection_id', collection.id)
    .eq('slug', itemSlug)
    .eq('status', 'published')
    .single()

  if (!item) return null

  // Get prev/next items in same category
  const category = Array.isArray(item.category) ? item.category[0] : item.category
  let prevItem: NavItem | null = null
  let nextItem: NavItem | null = null

  if (category) {
    const { data: siblings } = await supabase
      .from('sr_items')
      .select('title, slug')
      .eq('category_id', category.id)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })

    if (siblings) {
      const idx = siblings.findIndex(s => s.slug === itemSlug)
      if (idx > 0) prevItem = siblings[idx - 1]
      if (idx < siblings.length - 1) nextItem = siblings[idx + 1]
    }
  }

  // Sidebar nav: all categories + all published items in this collection
  const { data: navCategories } = await supabase
    .from('sr_categories')
    .select('id, name, slug')
    .eq('collection_id', collection.id)
    .order('sort_order', { ascending: true })

  const { data: navArticles } = await supabase
    .from('sr_items')
    .select('id, title, slug, category_id')
    .eq('collection_id', collection.id)
    .eq('status', 'published')
    .order('sort_order', { ascending: true })

  return {
    collection: collection as CollectionData,
    item: {
      ...item,
      category,
      sections: (item.sections || []).sort((a: any, b: any) => a.sort_order - b.sort_order),
    } as ItemData,
    prevItem,
    nextItem,
    categories: (navCategories || []) as NavCategory[],
    articles: (navArticles || []) as NavArticle[],
  }
}

interface Props {
  params: { collectionSlug: string; itemSlug: string }
}

export default async function ItemDetailPage({ params }: Props) {
  const session = await getSession()
  const isAuthenticated = !!session

  const data = await getItemData(params.collectionSlug, params.itemSlug, isAuthenticated)

  if (!data) {
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

  const { collection, item, prevItem, nextItem, categories, articles } = data

  // Absolute base for this brand — the serving host IS the canonical domain
  // (including custom domains), so JSON-LD @id/url values resolve correctly
  // per-tenant without hard-coding a domain.
  const reqHeaders = await headers()
  const host = reqHeaders.get('x-forwarded-host') || reqHeaders.get('host') || ''
  const proto = reqHeaders.get('x-forwarded-proto') || 'https'
  const base = host ? `${proto}://${host}` : ''
  const pageUrl = `${base}/resources/${collection.slug}/${item.slug}`

  // Full article body as clean text (drop links/images here — the rendered page
  // and the /md endpoint keep them; JSON-LD articleBody wants plain prose).
  const articleBody = item.sections
    .map((s) => [s.heading, s.content ? convert(s.content, { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }] }) : '']
      .filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n')
    .trim()

  const crumbs = [
    { name: 'Resources', url: `${base}/resources` },
    { name: collection.name, url: `${base}/resources/${collection.slug}` },
    ...(item.category ? [{ name: item.category.name, url: `${base}/resources/${collection.slug}?category=${item.category.slug}` }] : []),
    { name: item.title, url: pageUrl },
  ]

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        '@id': `${pageUrl}#article`,
        headline: item.title,
        ...(item.subtitle ? { description: item.subtitle } : {}),
        ...(item.featured_image_url ? { image: item.featured_image_url } : {}),
        ...(articleBody ? { articleBody } : {}),
        ...(item.created_at ? { datePublished: item.created_at } : {}),
        ...(item.updated_at ? { dateModified: item.updated_at } : {}),
        mainEntityOfPage: pageUrl,
        isPartOf: { '@type': 'Collection', name: collection.name, url: `${base}/resources/${collection.slug}` },
        ...(item.external_url ? { sameAs: item.external_url } : {}),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.url })),
      },
    ],
  }

  // Group articles under their category for the sidebar nav
  const articlesByCategory = new Map<string, NavArticle[]>()
  for (const a of articles) {
    const list = articlesByCategory.get(a.category_id) || []
    list.push(a)
    articlesByCategory.set(a.category_id, list)
  }

  const slugify = (s: string) => s.toLowerCase().replace(/\s+/g, '-')

  return (
    <div className="pub-article-wrap pub-fade">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <style>{`
        .res-article-grid { display: grid; grid-template-columns: 260px minmax(0,1fr); gap: 44px; align-items: start; }
        .res-nav-link { display: block; text-decoration: none; padding: 5px 9px; border-radius: 8px; font-size: 13.5px; color: var(--ink-3); transition: background .15s ease, color .15s ease; }
        .res-nav-link:hover { background: rgba(var(--ui-text), 0.06); color: var(--ink); }
        .res-nav-link[aria-current="page"] { background: rgba(var(--ui-text), 0.10); color: var(--ink); font-weight: 600; }
        @media (max-width: 760px) { .res-article-grid { grid-template-columns: 1fr; gap: 24px; } }
      `}</style>
      <div className="res-article-grid">
        {/* Left: browse the collection */}
        <aside className="pub-article-side">
          <div className="pub-side-card">
            <Link href={`/resources/${collection.slug}`} className="pub-side-val" style={{ textDecoration: 'none', display: 'block' }}>← {collection.name}</Link>
          </div>
          {categories.map((cat) => {
            const catArticles = articlesByCategory.get(cat.id) || []
            if (catArticles.length === 0) return null
            return (
              <div className="pub-side-card" key={cat.id}>
                <Link href={`/resources/${collection.slug}?category=${cat.slug}`} className="pub-side-h" style={{ display: 'block', textDecoration: 'none' }}>{cat.name}</Link>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {catArticles.map((a) => (
                    <Link
                      key={a.id}
                      href={`/resources/${collection.slug}/${a.slug}`}
                      aria-current={a.slug === item.slug ? 'page' : undefined}
                      className="res-nav-link"
                    >
                      {a.title}
                    </Link>
                  ))}
                </div>
              </div>
            )
          })}
        </aside>

        {/* Right: the article */}
        <article className="pub-article-main" style={{ minWidth: 0 }}>
          {/* Breadcrumb */}
          <div className="pub-byline" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
            <Link href="/resources" style={{ color: 'var(--ink-4)', textDecoration: 'none' }}>Resources</Link>
            <span>/</span>
            <Link href={`/resources/${collection.slug}`} style={{ color: 'var(--ink-4)', textDecoration: 'none' }}>{collection.name}</Link>
            {item.category && (
              <>
                <span>/</span>
                <Link href={`/resources/${collection.slug}?category=${item.category.slug}`} style={{ color: 'var(--ink-4)', textDecoration: 'none' }}>{item.category.name}</Link>
              </>
            )}
          </div>

          {item.featured_image_url && (
            <div style={{ aspectRatio: '16 / 9', overflow: 'hidden', borderRadius: 14, marginBottom: 24 }}>
              <SafeImg
                src={item.featured_image_url}
                alt={item.title}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            </div>
          )}

          <h1>{item.title}</h1>
          {item.subtitle && (
            <p style={{ color: 'var(--ink-3)', fontSize: 16, lineHeight: 1.6, margin: '-4px 0 16px' }}>{item.subtitle}</p>
          )}
          {item.external_url && (
            <a href={item.external_url} target="_blank" rel="noopener noreferrer" className="pub-link" style={{ color: 'var(--accent)', display: 'inline-block', marginBottom: 8 }}>
              {item.external_url} ↗
            </a>
          )}

          {/* Table of contents */}
          {item.sections.length > 1 && (
            <div className="pub-side-card" style={{ margin: '12px 0 28px' }}>
              <div className="pub-side-h">On this page</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {item.sections.map((section) => (
                  <a key={section.id} href={`#${slugify(section.heading)}`} className="res-nav-link">{section.heading}</a>
                ))}
              </div>
            </div>
          )}

          {/* Sections */}
          <div className="pub-body">
            {item.sections.map((section) => (
              <section key={section.id} id={slugify(section.heading)} style={{ scrollMarginTop: 96 }}>
                <h2>{section.heading}</h2>
                {section.content && <div dangerouslySetInnerHTML={{ __html: section.content }} />}
              </section>
            ))}
          </div>

          {/* Previous/Next navigation */}
          {(prevItem || nextItem) && (
            <div className="pub-prevnext">
              {prevItem ? (
                <Link href={`/resources/${collection.slug}/${prevItem.slug}`} className="pub-pn-card">
                  <div className="pub-side-sub">← Previous</div>
                  <div className="pub-side-val">{prevItem.title}</div>
                </Link>
              ) : <div />}
              {nextItem ? (
                <Link href={`/resources/${collection.slug}/${nextItem.slug}`} className="pub-pn-card" style={{ textAlign: 'right' }}>
                  <div className="pub-side-sub">Next →</div>
                  <div className="pub-side-val">{nextItem.title}</div>
                </Link>
              ) : <div />}
            </div>
          )}
        </article>
      </div>
    </div>
  )
}
