// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { getSupabaseClient } from '@/lib/supabase/client'
import { resolveStoragePathsInJson } from '@gatewaze/shared'
import { getClientBrandConfig } from '@/config/brand'
// Render the edition with the SAME declarative renderer the email/publish use,
// so the portal shows the real newsletter. The declarative path is dependency-
// light (react + @react-email/components + DOMParser) — no Puck/heroicons — so
// it's safe to pull into the portal bundle.
import { parseTemplate } from '@gatewaze-modules/newsletters/admin/components/puck/email-blocks/declarative/parse-template'
import { DeclarativeBlock } from '@gatewaze-modules/newsletters/admin/components/puck/email-blocks/declarative/render'
// Canonical edition slug (`<date>-<subject>`), shared with the git publish
// pipeline and the send-time "View Online" link so URLs always agree.
import { editionFolderSlug } from '@gatewaze-modules/newsletters/lib/edition-slug'
// Resolve merge-field tokens (e.g. `{{first_name|"there"}}`) using empty
// attrs so the fallback in each token always wins on the public View Online
// page. The declarative renderer's `{{X}}` lookup can't parse the `|fallback`
// suffix, so without this pre-pass the literal token leaks into the rendered
// HTML and a reader sees `Hey {{first_name|"there"}}!`.
import { substituteMergeFieldsInContent } from '@gatewaze-modules/newsletters/lib/merge-fields'

const NO_RECIPIENT_ATTRS = {} as const

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

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

// Canonical edition path: /newsletters/<collection-slug>/<date-subject-slug>
function editionHref(collectionSlug: string, editionDate: string, title: string | null): string {
  return `/newsletters/${collectionSlug}/${editionFolderSlug(editionDate, title)}`
}

export default function NewsletterEditionPage({ params }: { params: { collection: string; edition: string } }) {
  const [edition, setEdition] = useState<EditionData | null>(null)
  const [others, setOthers] = useState<Array<{ id: string; title: string | null; edition_date: string }>>([])
  // Slot-block bricks: edition bricks grouped by block id, plus a brick_type →
  // declarative-source map, so slot blocks (e.g. mlops_community) render their
  // bricks as the slot's children.
  const [bricksByBlock, setBricksByBlock] = useState<Record<string, any[]>>({})
  const [brickTpls, setBrickTpls] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // URL format: /newsletters/<collection>/<date-subject-slug>. The leading 10
  // chars of the edition segment are the date; the rest is the subject slug,
  // used to disambiguate multiple same-day editions.
  const slug = params.collection || ''
  const editionParam = params.edition || ''
  const date = editionParam.slice(0, 10)

  useEffect(() => {
    if (!slug || !date) {
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

        // Get edition(s) by date; if several share a day, match the one whose
        // canonical slug equals the URL segment.
        const { data: candidates } = await supabase
          .from('newsletters_editions')
          .select('id, title, edition_date, preheader, collection_id')
          .eq('collection_id', newsletter.id)
          .eq('edition_date', date)
          .eq('status', 'published')
          .order('created_at', { ascending: false })

        const editionData =
          (candidates || []).find(
            (c: any) => editionFolderSlug(c.edition_date, c.title) === editionParam,
          ) || (candidates || [])[0]

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

        // Other published editions of this newsletter — for the sidebar.
        const { data: otherEds } = await supabase
          .from('newsletters_editions')
          .select('id, title, edition_date')
          .eq('collection_id', newsletter.id)
          .eq('status', 'published')
          .neq('id', editionData.id)
          .order('edition_date', { ascending: false })
          .limit(20)
        setOthers(otherEds || [])

        // Slot-block bricks + their declarative templates (for mlops_community
        // etc.). Bricks join to templates_brick_defs by brick_type === key.
        const blockIds = (blocks || []).map((b: any) => b.id)
        if (blockIds.length) {
          const [bricksRes, brickDefsRes] = await Promise.all([
            supabase
              .from('newsletters_edition_bricks')
              .select('id, block_id, brick_type, content, sort_order')
              .in('block_id', blockIds)
              .order('sort_order'),
            supabase
              .from('templates_brick_defs')
              .select('key, html, templates_block_defs!inner(library_id)')
              .eq('templates_block_defs.library_id', newsletter.id),
          ])
          const byBlock: Record<string, any[]> = {}
          for (const br of bricksRes.data || []) (byBlock[br.block_id] ||= []).push(br)
          setBricksByBlock(byBlock)
          const tplMap: Record<string, string> = {}
          for (const d of (brickDefsRes.data as any[]) || []) tplMap[d.key] = d.html || ''
          setBrickTpls(tplMap)
        }
      } catch (err) {
        console.error('Error loading edition:', err)
        setError('Failed to load newsletter')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [slug, date, editionParam])

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

  const brand = getClientBrandConfig()

  return (
    <div className="pub-article-wrap pub-fade">
      {/* The edition renders as a fixed ~650px email; constrain its tables and
          images so the panel shrinks to fit narrow viewports instead of forcing
          the column (and the title) wider than the screen. min-width:0 lets the
          grid column shrink below its email content's intrinsic width. */}
      <style>{`
        .pub-article-main { min-width: 0; }
        .pub-article-main h1 { overflow-wrap: anywhere; }
        .nl-edition-render { max-width: 100%; }
        .nl-edition-render table { max-width: 100% !important; }
        .nl-edition-render img { max-width: 100% !important; height: auto !important; }
      `}</style>
      <div className="pub-article-grid">
        {/* Left: the real edition, rendered with the declarative renderer so it
            matches the sent/published newsletter exactly. */}
        <article className="pub-article-main" style={{ minWidth: 0 }}>
          <div className="pub-byline">
            {edition.newsletter_name} · {formatDate(edition.edition_date)}
          </div>
          <h1>{edition.title || 'Newsletter Edition'}</h1>
          {edition.preheader && <p className="pub-byline" style={{ marginTop: 0 }}>{edition.preheader}</p>}

          <div className="nl-edition-render" style={{ background: '#fff', borderRadius: 14, overflow: 'hidden', padding: '12px 16px', marginTop: 20 }}>
            {edition.blocks
              // Email-only blocks (block_type starting with `email_only_`)
              // render in the sent email but are filtered out of the public
              // View Online archive. Use case: apology / correction headers
              // on a re-send (added 2026-06-24 after the mlopscommunity
              // 56k send shipped without its body block). The filter is on
              // the PREFIX so any future email-only variant (e.g.
              // email_only_signoff) is excluded automatically. See
              // templates_block_defs for email_only_intro (migration 058)
              // and modules/newsletters/admin/components/puck/email-blocks/
              // blocks/EmailOnlyIntro.tsx for the React component.
              .filter((b) => !(b.block_type ?? '').startsWith('email_only_'))
              .sort((a, b) => a.sort_order - b.sort_order)
              .map((block) => {
                const tpl = block.block_template
                const source = (tpl?.html || tpl?.rich_text_template || '') as string
                const resolvedContent = brand.storageBucketUrl
                  ? resolveStoragePathsInJson(block.content, brand.storageBucketUrl)
                  : block.content
                // Substitute merge tokens with their fallbacks (no recipient on
                // the public View Online page; every {{first_name|"there"}}
                // resolves to "there"). MUST happen before the declarative
                // renderer sees the content map.
                const personalisedContent = substituteMergeFieldsInContent(resolvedContent, NO_RECIPIENT_ATTRS)
                let nodes: any[] = []
                try { nodes = parseTemplate(source).nodes } catch { nodes = [] }
                if (!nodes.length) return null
                // Slot blocks: render their bricks as the slot's children.
                const blockBricks = bricksByBlock[block.id] || []
                let content: any = personalisedContent
                if (blockBricks.length) {
                  const children = blockBricks.map((br: any, i: number) => {
                    let bNodes: any[] = []
                    try { bNodes = parseTemplate(brickTpls[br.brick_type] || '').nodes } catch { bNodes = [] }
                    if (!bNodes.length) return null
                    const bContent = brand.storageBucketUrl
                      ? resolveStoragePathsInJson(br.content, brand.storageBucketUrl)
                      : br.content
                    const bPersonalised = substituteMergeFieldsInContent(bContent, NO_RECIPIENT_ATTRS)
                    return <DeclarativeBlock key={br.id || i} nodes={bNodes} content={bPersonalised as any} />
                  }).filter(Boolean)
                  content = { ...(personalisedContent as any), children }
                }
                return <DeclarativeBlock key={block.id} nodes={nodes} content={content} />
              })}
          </div>
        </article>

        {/* Right: other editions of this newsletter. */}
        <aside className="pub-article-side">
          <div className="pub-side-card">
            <div className="pub-side-h">More from {edition.newsletter_name}</div>
            {others.length === 0 ? (
              <div className="pub-side-sub">No other editions yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {others.map((o) => (
                  <Link
                    key={o.id}
                    href={editionHref(edition.newsletter_slug, o.edition_date, o.title)}
                    style={{ display: 'block', textDecoration: 'none' }}
                  >
                    <div className="pub-side-val">{o.title || 'Untitled'}</div>
                    <div className="pub-side-sub">{formatDate(o.edition_date)}</div>
                  </Link>
                ))}
              </div>
            )}
          </div>
          <div className="pub-side-card">
            <Link href="/newsletters" className="pub-side-val" style={{ textDecoration: 'none' }}>
              ← All newsletters
            </Link>
          </div>
        </aside>
      </div>
    </div>
  )
}
