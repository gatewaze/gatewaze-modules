// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { getSupabaseClient } from '@/lib/supabase/client'
import { resolveStoragePathsInJson } from '@gatewaze/shared'
import { getClientBrandConfig } from '@/config/brand'

interface EditionData {
  id: string
  title: string | null
  edition_date: string
  preheader: string | null
  collection_id: string
  newsletter_name: string
  newsletter_slug: string
  accent_color: string | null
  blocks: Array<{
    id: string
    block_type: string
    content: Record<string, unknown>
    sort_order: number
    block_template: {
      name: string
      html: string | null
      rich_text_template: string | null
    }
  }>
}

function renderTemplate(template: string, data: Record<string, unknown>): string {
  if (!template) return ''
  let result = template

  // Sections: {{#key}}...{{/key}}
  result = result.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, inner) => {
    const val = data[key]
    if (!val) return ''
    if (Array.isArray(val)) return val.map(item => renderTemplate(inner, item)).join('')
    return renderTemplate(inner, typeof val === 'object' ? val as Record<string, unknown> : data)
  })

  // Inverted sections: {{^key}}...{{/key}}
  result = result.replace(/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, inner) => {
    const val = data[key]
    if (!val || (Array.isArray(val) && val.length === 0)) return inner
    return ''
  })

  // Variables: {{key}}
  result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = data[key]
    return val != null ? String(val) : ''
  })

  return result
}

function stripEmailHtml(html: string): string {
  let clean = html
  clean = clean.replace(/<!--\[if[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi, '')
  clean = clean.replace(/\s*style="[^"]*"/gi, '')
  clean = clean.replace(/\s*style='[^']*'/gi, '')
  clean = clean.replace(/<table[^>]*>/gi, '')
  clean = clean.replace(/<\/table>/gi, '')
  clean = clean.replace(/<tbody[^>]*>/gi, '')
  clean = clean.replace(/<\/tbody>/gi, '')
  clean = clean.replace(/<thead[^>]*>/gi, '')
  clean = clean.replace(/<\/thead>/gi, '')
  clean = clean.replace(/<tr[^>]*>/gi, '')
  clean = clean.replace(/<\/tr>/gi, '')
  clean = clean.replace(/<td[^>]*>/gi, '')
  clean = clean.replace(/<\/td>/gi, '')
  clean = clean.replace(/<th[^>]*>/gi, '')
  clean = clean.replace(/<\/th>/gi, '')
  clean = clean.replace(/\s*align="[^"]*"/gi, '')
  clean = clean.replace(/\s*bgcolor="[^"]*"/gi, '')
  clean = clean.replace(/\s*border="[^"]*"/gi, '')
  clean = clean.replace(/\s*cellpadding="[^"]*"/gi, '')
  clean = clean.replace(/\s*cellspacing="[^"]*"/gi, '')
  clean = clean.replace(/\s*width="[^"]*"/gi, '')
  clean = clean.replace(/\s*height="[^"]*"/gi, '')
  clean = clean.replace(/\s*role="[^"]*"/gi, '')
  clean = clean.replace(/\s*class="[^"]*"/gi, '')
  clean = clean.replace(/<div>\s*<\/div>/gi, '')
  clean = clean.replace(/<span>\s*<\/span>/gi, '')
  clean = clean.replace(/\n{3,}/g, '\n\n')
  return clean.trim()
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export default function NewsletterEditionPage({ params }: { params: { date: string } }) {
  const [edition, setEdition] = useState<EditionData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // URL format: /newsletters/{slug}--{date}
  const parts = params.date?.split('--') || []
  const slug = parts.length > 1 ? parts[0] : ''
  const date = parts.length > 1 ? parts[1] : params.date

  useEffect(() => {
    if (!slug) {
      setError('Invalid URL')
      setLoading(false)
      return
    }

    async function load() {
      try {
        const supabase = getSupabaseClient()

        // Get newsletter (RLS handles visibility)
        const { data: newsletter } = await supabase
          .from('newsletters_template_collections')
          .select('id, name, slug, accent_color')
          .eq('slug', slug)
          .single()

        if (!newsletter) {
          setError('Newsletter not found')
          setLoading(false)
          return
        }

        // Get edition by date
        const { data: editionData } = await supabase
          .from('newsletters_editions')
          .select('id, title, edition_date, preheader, collection_id')
          .eq('collection_id', newsletter.id)
          .eq('edition_date', date)
          .eq('status', 'published')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (!editionData) {
          setError('Edition not found')
          setLoading(false)
          return
        }

        // Get blocks with templates (joined to templates_block_defs).
        // The block_def_id FK is templates_block_def_id (added in migration 020).
        const { data: blocks } = await supabase
          .from('newsletters_edition_blocks')
          .select('id, block_type, content, sort_order, block_template:templates_block_defs!templates_block_def_id(name, html, rich_text_template)')
          .eq('edition_id', editionData.id)
          .order('sort_order')

        setEdition({
          ...editionData,
          newsletter_name: newsletter.name,
          newsletter_slug: newsletter.slug,
          accent_color: newsletter.accent_color,
          blocks: (blocks || []).map((b: any) => ({
            ...b,
            block_template: Array.isArray(b.block_template) ? b.block_template[0] : b.block_template,
          })),
        })
      } catch (err) {
        console.error('Error loading edition:', err)
        setError('Failed to load newsletter')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [slug, date])

  if (loading) {
    return (
      <main className="relative z-10">
        <div className="max-w-7xl mx-auto px-6 py-12 flex justify-center">
          <div className="animate-spin w-6 h-6 border-2 border-white/30 border-t-white rounded-full" />
        </div>
      </main>
    )
  }

  if (error || !edition) {
    return (
      <main className="relative z-10">
        <div className="max-w-7xl mx-auto px-6 py-12 text-center">
          <h1 className="text-2xl font-bold text-white mb-4">{error || 'Edition not found'}</h1>
          <Link href="/newsletters" className="text-white/60 hover:text-white underline">
            Back to newsletters
          </Link>
        </div>
      </main>
    )
  }

  const accentColor = edition.accent_color || '#00a2c7'

  return (
    <main className="relative z-10">
      <div className="max-w-7xl mx-auto px-6 sm:px-6 lg:px-8 py-8 sm:py-12">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-base text-white/50 mb-6">
          <Link href="/newsletters" className="hover:text-white/80 transition-colors">
            Newsletters
          </Link>
          <span>/</span>
          <Link href="/newsletters" className="hover:text-white/80 transition-colors">
            {edition.newsletter_name}
          </Link>
        </div>

        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-1 h-6 rounded-full" style={{ backgroundColor: accentColor }} />
            <span className="text-white/50 text-base">{edition.newsletter_name}</span>
            <span className="text-white/30">·</span>
            <span className="text-white/50 text-base">{formatDate(edition.edition_date)}</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold text-white">
            {edition.title || 'Newsletter Edition'}
          </h1>
          {edition.preheader && (
            <p className="text-white/60 text-lg mt-2">{edition.preheader}</p>
          )}
        </div>

        {/* Content */}
        <div className="bg-white/5 rounded-2xl border border-white/10 overflow-hidden">
          {edition.blocks
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((block) => {
              const tpl = block.block_template
              const htmlTemplate = (tpl?.rich_text_template || tpl?.html || '') as string
              const brand = getClientBrandConfig()
              const resolvedContent = brand.storageBucketUrl
                ? resolveStoragePathsInJson(block.content, brand.storageBucketUrl)
                : block.content
              let rendered = renderTemplate(htmlTemplate, resolvedContent as Record<string, unknown>)

              if (!rendered.trim()) return null

              rendered = stripEmailHtml(rendered)

              return (
                <div
                  key={block.id}
                  className="px-6 sm:px-10 py-6 border-b border-white/5 last:border-0"
                >
                  <div
                    className="prose prose-invert prose-lg max-w-none
                      prose-headings:text-white prose-headings:font-bold
                      prose-p:text-white/80 prose-p:leading-relaxed
                      prose-a:text-sky-400 prose-a:no-underline hover:prose-a:underline
                      prose-li:text-white/80
                      prose-strong:text-white
                      prose-img:rounded-xl prose-img:mx-auto"
                    dangerouslySetInnerHTML={{ __html: rendered }}
                  />
                </div>
              )
            })}
        </div>

        {/* Back link */}
        <div className="mt-8 text-center">
          <Link
            href="/newsletters"
            className="text-white/50 hover:text-white text-base transition-colors"
          >
            ← Back to all newsletters
          </Link>
        </div>
      </div>
    </main>
  )
}
