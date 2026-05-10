import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router';
import {
  ArrowLeftIcon,
  Cog6ToothIcon,
  PencilSquareIcon,
  PaperAirplaneIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Page } from '@/components/shared/Page';
import { Badge } from '@/components/ui';
import { Tabs } from '@/components/ui';
import type { Tab } from '@/components/ui/Tabs';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { NewsletterCanvasEditor } from '../../components/puck/NewsletterCanvasEditor';
import { EditionSendingTab } from '../../components/EditionSendingTab';
import { supabase } from '@/lib/supabase';
import { useHasModule } from '@/hooks/useModuleFeature';
import { stripStorageUrlsInJson } from '@gatewaze/shared';
import {
  type NewsletterEdition,
  type BlockTemplate,
  type BrickTemplate,
  generateNewsletterHtml,
} from '../../utils';

/** Shape of a templates_block_defs row, with `block_type` aliased from `key`. */
interface DbBlockTemplate {
  id: string;
  name: string;
  /** Aliased from templates_block_defs.key in the SELECT. */
  block_type: string;
  description: string | null;
  schema: Record<string, unknown>;
  html: string | null;
  rich_text_template: string | null;
  has_bricks: boolean;
  sort_order: number;
}

interface DbBrickTemplate {
  id: string;
  name: string;
  /** Aliased from templates_brick_defs.key. */
  brick_type: string;
  schema: Record<string, unknown>;
  html: string | null;
  rich_text_template: string | null;
  block_def_id: string;
  sort_order: number;
}

interface DbEditionBlock {
  id: string;
  edition_id: string;
  /** FK to templates_block_defs.id (after PR 16.b). */
  templates_block_def_id: string;
  content: Record<string, unknown>;
  sort_order: number;
  block_template: DbBlockTemplate;
}

interface DbEditionBrick {
  id: string;
  block_id: string;
  /** FK to templates_brick_defs.id (after PR 16.b). */
  templates_brick_def_id: string;
  content: Record<string, unknown>;
  sort_order: number;
  brick_template: DbBrickTemplate;
}

interface CollectionInfo {
  id: string;
  name: string;
  slug: string;
  accent_color: string | null;
  content_category: string | null;
  list_id: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  metadata: Record<string, unknown>;
  list_name?: string | null;
  subscriber_count?: number;
}

type EditionTab = 'details' | 'editor' | 'sending';

export default function EditionEditorPage() {
  const { id, tab: tabFromUrl, slug: newsletterSlug } = useParams<{ id: string; tab?: string; slug?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isNew = id === 'new';
  const hasBulkEmailing = useHasModule('bulk-emailing');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [edition, setEdition] = useState<NewsletterEdition | null>(null);
  const [blockTemplates, setBlockTemplates] = useState<(DbBlockTemplate & BlockTemplate)[]>([]);
  const [brickTemplates, setBrickTemplates] = useState<BrickTemplate[]>([]);
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [collection, setCollection] = useState<CollectionInfo | null>(null);
  const [collectionMetadata, setCollectionMetadata] = useState<Record<string, unknown>>({});
  const validTabs: EditionTab[] = ['editor', 'details', ...(hasBulkEmailing ? ['sending' as EditionTab] : [])];
  const defaultTab: EditionTab = 'editor';
  const activeTab: EditionTab = validTabs.includes(tabFromUrl as EditionTab) ? (tabFromUrl as EditionTab) : defaultTab;

  const handleTabChange = (tab: string) => {
    const basePath = newsletterSlug ? `/newsletters/${newsletterSlug}/editions` : '/newsletters/editor';
    navigate(`${basePath}/${id}/${tab}`, { replace: true });
  };

  const loadCollection = useCallback(async (cId: string): Promise<Record<string, unknown> | null> => {
    const { data } = await supabase
      .from('newsletters_template_collections')
      .select('*')
      .eq('id', cId)
      .single();

    if (data) {
      const collInfo: CollectionInfo = { ...data };
      const metadata = {
        ...(data.metadata || {}),
        from_name: data.from_name || null,
        from_email: data.from_email || null,
      };
      setCollectionMetadata(metadata);

      if (data.list_id) {
        try {
          const { data: listData, error: listErr } = await supabase.from('lists').select('name').eq('id', data.list_id).single();
          if (listErr) {
            console.warn('[newsletter] Failed to load list:', listErr.message);
          } else if (listData) {
            collInfo.list_name = listData.name;
            const { count, error: countErr } = await supabase.from('list_subscriptions').select('id', { count: 'exact', head: true }).eq('list_id', data.list_id).eq('subscribed', true);
            if (countErr) console.warn('[newsletter] Failed to count subscribers:', countErr.message);
            collInfo.subscriber_count = count || 0;
          }
        } catch (err) {
          console.warn('[newsletter] Lists module may not be installed:', err);
        }
      }

      setCollection(collInfo);
      return data.metadata as Record<string, unknown> | null;
    }
    return null;
  }, []);

  const loadTemplates = useCallback(async (filterCollectionId?: string | null) => {
    try {
      // Aliases: templates_block_defs.key → block_type so the consumer-facing
      // shape stays stable. sort_order isn't on templates_block_defs (no
      // library-wide ordering); we fall back to ordering by `key`.
      let blocksQuery = supabase
        .from('templates_block_defs')
        .select('id, key, name, description, schema, html, rich_text_template, has_bricks, render_kind, component_id, block_type:key')
        .order('key');
      // Bricks: filter by parent block_def's library via inner-embed join.
      let bricksQuery = supabase
        .from('templates_brick_defs')
        .select('id, block_def_id, key, name, schema, html, rich_text_template, sort_order, brick_type:key, templates_block_defs!inner(library_id)')
        .order('sort_order');
      if (filterCollectionId) {
        blocksQuery = blocksQuery.eq('library_id', filterCollectionId);
        bricksQuery = bricksQuery.eq('templates_block_defs.library_id', filterCollectionId);
      }
      const [blocksRes, bricksRes] = await Promise.all([blocksQuery, bricksQuery]);
      if (blocksRes.error) throw blocksRes.error;
      if (bricksRes.error) throw bricksRes.error;
      setBlockTemplates(blocksRes.data || []);
      setBrickTemplates(bricksRes.data || []);
    } catch (error) {
      console.error('Error loading templates:', error);
      toast.error('Failed to load templates');
    }
  }, []);

  const loadEdition = useCallback(async () => {
    if (isNew) {
      const collParam = searchParams.get('collection');
      if (!collParam) { toast.error('Please select a template first'); navigate(newsletterSlug ? `/newsletters/${newsletterSlug}` : '/newsletters'); return; }
      setCollectionId(collParam);
      const meta = await loadCollection(collParam);
      // Apply the newsletter-level default edition template if set.
      // The Default Edition Template card on the newsletter detail
      // page persists the chosen slug to
      // newsletters_template_collections.metadata.default_edition_template_slug.
      // We resolve it here so a new edition starts with the same
      // layout edition-after-edition without the operator clicking
      // anything per-edition.
      const slug = (meta && typeof meta === 'object' ? (meta as Record<string, unknown>).default_edition_template_slug : undefined);
      let initialBlocks: NewsletterEdition['blocks'] = [];
      if (typeof slug === 'string' && slug.length > 0) {
        try {
          const { ALL_STARTERS } = await import('../../components/puck/starter-templates/index.js');
          const starter = ALL_STARTERS.find((s) => s.slug === slug);
          if (starter) {
            initialBlocks = starter.blocks.map((b, idx) => ({
              id: freshUuid(),
              block_template: {
                id: '',
                name: b.type,
                block_type: b.type,
                content: { html_template: '', schema: {}, has_bricks: false },
              },
              content: stampIdsRecursive({ ...b.props }),
              sort_order: (idx + 1) * 1000,
              bricks: [],
            } as never));
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[edition-new] failed to apply default template:', e);
        }
      }
      setEdition({ id: 'new', edition_date: new Date().toISOString().split('T')[0], subject: '', preheader: '', blocks: initialBlocks });
      setLoading(false);
      return;
    }

    try {
      const { data: editionData, error: editionError } = await supabase.from('newsletters_editions').select('*').eq('id', id).single();
      if (editionError) throw editionError;

      if (editionData.collection_id) {
        setCollectionId(editionData.collection_id);
        await loadCollection(editionData.collection_id);
      }

      const { data: blocksData, error: blocksError } = await supabase
        .from('newsletters_edition_blocks')
        .select('*, block_template:templates_block_defs!templates_block_def_id(id, key, name, description, schema, html, rich_text_template, has_bricks, block_type:key)')
        .eq('edition_id', id)
        .order('sort_order');
      if (blocksError) throw blocksError;

      const blockIds = (blocksData || []).map((b: DbEditionBlock) => b.id);
      let bricksData: DbEditionBrick[] = [];
      if (blockIds.length > 0) {
        const { data: bricks, error: bricksError } = await supabase
          .from('newsletters_edition_bricks')
          .select('*, brick_template:templates_brick_defs!templates_brick_def_id(id, block_def_id, key, name, schema, html, rich_text_template, sort_order, brick_type:key)')
          .in('block_id', blockIds)
          .order('sort_order');
        if (bricksError) throw bricksError;
        bricksData = bricks || [];
      }

      setEdition({
        id: editionData.id,
        edition_date: editionData.edition_date,
        subject: editionData.title || '',
        preheader: editionData.preheader || '',
        status: editionData.status,
        blocks: (blocksData || []).map((block: DbEditionBlock) => ({
          id: block.id,
          // Per spec-builder-evaluation §3.6 (extended). When the row has
          // no joined block_template (registry-driven block — saved with
          // templates_block_def_id=NULL), synthesise a BlockTemplate
          // shaped like a Mustache one but with `id: ''` so the editor
          // recognises it as a registry block. The downstream Puck
          // adapter looks up `block_type` (= the registry componentId)
          // against the registry to mount the right JSX component.
          block_template: block.block_template ?? {
            id: '',
            name: block.block_type,
            block_type: block.block_type,
            content: { html_template: '', schema: {}, has_bricks: false },
          },
          content: block.content || {},
          sort_order: block.sort_order,
          bricks: bricksData
            .filter((brick: DbEditionBrick) => brick.block_id === block.id)
            .map((brick: DbEditionBrick) => ({
              id: brick.id,
              brick_template: brick.brick_template,
              content: brick.content || {},
              sort_order: brick.sort_order,
            })),
        })),
      });
    } catch (error) {
      console.error('Error loading edition:', error);
      toast.error('Failed to load edition');
      navigate(newsletterSlug ? `/newsletters/${newsletterSlug}` : '/newsletters');
    } finally {
      setLoading(false);
    }
  }, [id, isNew, navigate, searchParams, loadCollection, newsletterSlug]);

  useEffect(() => { loadEdition(); }, [loadEdition]);
  useEffect(() => { if (collectionId) loadTemplates(collectionId); }, [collectionId, loadTemplates]);

  const handleSave = async (options?: { silent?: boolean }) => {
    if (!edition) return;
    setSaving(true);
    try {
      if (isNew) {
        const { data: rows, error: createError } = await supabase
          .from('newsletters_editions')
          .insert({
            edition_date: edition.edition_date,
            title: edition.subject || 'Untitled',
            preheader: edition.preheader || null,
            content_category: collection?.content_category || null,
            status: 'draft',
            collection_id: collectionId,
          })
          .select();
        if (createError) throw createError;
        const newEdition = rows?.[0];
        if (!newEdition) throw new Error('Edition created but not returned — try saving again');

        for (const block of edition.blocks) {
          const { data: blockRows, error: blockError } = await supabase
            .from('newsletters_edition_blocks')
            .insert({
              id: block.id,
              edition_id: newEdition.id,
              templates_block_def_id: block.block_template.id,
              block_type: block.block_template.block_type,
              content: stripStorageUrlsInJson(block.content),
              sort_order: block.sort_order,
            })
            .select();
          if (blockError) throw blockError;
          const newBlock = blockRows?.[0];
          if (newBlock) {
            for (const brick of block.bricks) {
              const { error: brickErr } = await supabase.from('newsletters_edition_bricks').insert({
                id: brick.id,
                block_id: newBlock.id,
                templates_brick_def_id: brick.brick_template.id,
                brick_type: brick.brick_template.brick_type,
                content: stripStorageUrlsInJson(brick.content),
                sort_order: brick.sort_order,
              });
              if (brickErr) throw brickErr;
            }
          }
        }

        if (options?.silent) {
          // Autosave: update URL without a full navigation so the
          // component tree stays mounted (preserves iframe, embed URL,
          // local state). Flip edition.id so subsequent saves go through
          // the UPDATE path instead of re-inserting.
          const edBasePath = newsletterSlug ? `/newsletters/${newsletterSlug}/editions` : '/newsletters/editor';
          window.history.replaceState(null, '', `${edBasePath}/${newEdition.id}/editor`);
          setEdition(prev => prev ? { ...prev, id: newEdition.id } : prev);
        } else {
          toast.success('Edition created');
          const edBasePath = newsletterSlug ? `/newsletters/${newsletterSlug}/editions` : '/newsletters/editor';
          navigate(`${edBasePath}/${newEdition.id}/editor`, { replace: true });
        }
      } else {
        const { error: updateErr } = await supabase.from('newsletters_editions').update({
          edition_date: edition.edition_date, title: edition.subject || 'Untitled',
          preheader: edition.preheader || null, content_category: collection?.content_category || null,
          updated_at: new Date().toISOString(),
        }).eq('id', edition.id);
        if (updateErr) { console.error('Update edition error:', updateErr); throw updateErr; }

        const { error: deleteErr } = await supabase.from('newsletters_edition_blocks').delete().eq('edition_id', edition.id);
        if (deleteErr) { console.error('Delete blocks error:', deleteErr); throw deleteErr; }

        for (const block of edition.blocks) {
          // Registry blocks (render_kind='react-email') carry a synthesised
          // BlockTemplate with `id: ''` from puckDataToEdition — there's no
          // matching `templates_block_defs` row to point at. Persist as
          // NULL templates_block_def_id; `block_type` carries the registry
          // componentId so the load path can synthesise the template back.
          // Per spec-builder-evaluation §3.6 (extended).
          const tplDefId = block.block_template.id && block.block_template.id !== ''
            ? block.block_template.id
            : null;
          const { data: blockRows, error: blockInsertErr } = await supabase
            .from('newsletters_edition_blocks')
            .insert({
              id: block.id,
              edition_id: edition.id,
              templates_block_def_id: tplDefId,
              block_type: block.block_template.block_type,
              content: stripStorageUrlsInJson(block.content),
              sort_order: block.sort_order,
            })
            .select();
          if (blockInsertErr) {
            console.error('Block insert error:', blockInsertErr);
            throw blockInsertErr;
          }
          const newBlock = blockRows?.[0];
          if (newBlock) {
            for (const brick of block.bricks) {
              const { error: brickInsertErr } = await supabase.from('newsletters_edition_bricks').insert({
                id: brick.id,
                block_id: newBlock.id,
                templates_brick_def_id: brick.brick_template.id,
                brick_type: brick.brick_template.brick_type,
                content: stripStorageUrlsInJson(brick.content),
                sort_order: brick.sort_order,
              });
              if (brickInsertErr) console.error('Brick insert error:', brickInsertErr);
            }
          }
        }
        if (!options?.silent) toast.success('Edition saved');

        // Per spec-builder-evaluation §3.6 (extended). After the DB
        // round-trip succeeds, fire the publish-to-git endpoint to
        // commit a rendered HTML snapshot to the newsletter's
        // internal repo. The endpoint is tolerant: if NEWSLETTERS_
        // BOILERPLATE_URL isn't set OR the gitServer dep isn't wired,
        // it returns 200 { kind: 'skipped' } and the editor flow
        // continues unchanged. Failures here MUST NOT bubble up — the
        // DB save is authoritative; the git mirror is best-effort.
        if (!options?.silent) {
          void fetch(`/api/admin/newsletters/editions/${edition.id}/publish-to-git`, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              ...(await (async () => {
                const { data } = await supabase.auth.getSession();
                const token = data.session?.access_token;
                return token ? { Authorization: `Bearer ${token}` } : {};
              })()),
            },
          })
            .then(async (res) => {
              if (!res.ok) {
                console.warn('[publish-to-git] non-2xx response', res.status, await res.text().catch(() => ''));
                return;
              }
              const body = (await res.json().catch(() => null)) as { kind?: string; commitSha?: string; reason?: string } | null;
              if (body?.kind === 'published' && body.commitSha) {
                toast.success(`Published to git (${body.commitSha.slice(0, 7)})`);
              } else if (body?.kind === 'skipped' && body.reason) {
                console.info('[publish-to-git] skipped:', body.reason);
              }
            })
            .catch((e: unknown) => {
              console.warn('[publish-to-git] request failed:', e);
            });
        }
      }
    } catch (error) {
      console.error('Error saving edition:', error);
      if (!options?.silent) toast.error('Failed to save edition');
      throw error;
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <Page title="Loading..."><div className="flex items-center justify-center h-64"><LoadingSpinner /></div></Page>;
  }

  if (!edition) {
    return <Page title="Not Found"><div className="p-6 text-center text-[var(--gray-9)]">Edition not found</div></Page>;
  }

  const accentColor = collection?.accent_color || '#00a2c7';
  const status = (edition as any).status || 'draft';
  const statusColor = status === 'published' ? 'green' : status === 'archived' ? 'orange' : 'gray';

  const ic = 'size-4';
  const tabs: Tab[] = [
    { id: 'editor', label: 'Editor', icon: <PencilSquareIcon className={ic} /> },
    { id: 'details', label: 'Details', icon: <Cog6ToothIcon className={ic} /> },
    ...(hasBulkEmailing ? [{ id: 'sending', label: 'Sending', icon: <PaperAirplaneIcon className={ic} /> }] : []),
  ];

  return (
    <Page title={edition.subject || 'Newsletter Edition'}>
      {/* Hero Header */}
      <div
        className="relative -mx-(--margin-x) -mt-(--margin-x) overflow-hidden"
        style={{ background: `linear-gradient(135deg, #1a1a2e 0%, ${accentColor}30 50%, #1a1a2e 100%)` }}
      >
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 to-black/60 pointer-events-none" />
        <div className="relative" style={{ padding: '1.5rem calc(var(--margin-x) + 1.5rem) 1.75rem' }}>
          <button
            onClick={() => navigate(newsletterSlug ? `/newsletters/${newsletterSlug}/editions` : '/newsletters')}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-white/90 backdrop-blur-md border border-white/40 text-gray-900 shadow-sm hover:bg-white transition-colors mb-3"
          >
            <ArrowLeftIcon className="w-4 h-4" /> Back
          </button>
          <h1 className="text-2xl md:text-3xl lg:text-4xl font-bold text-white mb-2">{edition.subject || 'New Edition'}</h1>
          <div className="flex items-center gap-3 flex-wrap">
            {collection && (
              <span className="px-3 py-1.5 bg-white/10 backdrop-blur-sm rounded-lg text-sm text-white/90">{collection.name}</span>
            )}
            <span className="px-3 py-1.5 bg-white/10 backdrop-blur-sm rounded-lg text-sm text-white/90">
              {new Date(edition.edition_date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
            </span>
            <Badge variant="soft" color={statusColor as any} size="1">
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </Badge>
            {collection?.content_category && (
              <Badge variant="soft" color="blue" size="1">{collection.content_category}</Badge>
            )}
          </div>
        </div>
      </div>

      {/* Tab Bar */}
      <div className="-mx-(--margin-x)">
        <Tabs fullWidth value={activeTab} onChange={handleTabChange} tabs={tabs} />
      </div>

      {/* Tab Content */}
      {activeTab === 'editor' && (
        <div
          className="-mx-(--margin-x)"
          // Edge-to-edge so Puck's drawer + canvas + right sidebar
          // chrome (and their dividing borders) extend the full
          // white-area width. The hero-matching horizontal alignment
          // happens INSIDE Puck via CSS rules in
          // PUCK_RADIX_THEME_CSS — they pad the left drawer's
          // contents (Blocks / Outline icons) and the right
          // sidebar's contents inward, leaving the chrome flush
          // with the admin's edges.
          style={{ minHeight: 'calc(100vh - 220px)' }}
        >
          <NewsletterCanvasEditor
            edition={edition}
            blockTemplates={blockTemplates}
            brickTemplates={brickTemplates}
            collectionMetadata={collectionMetadata}
            {...(collectionId ? { collectionId } : {})}
            // Per spec-builder-evaluation §3.6 (extended). When the bound
            // library has explicit `render_kind='react-email'` rows, surface
            // ONLY those component_ids (production opt-in pattern). When
            // the library has zero such rows yet, omit the prop entirely
            // — the merge helper then exposes the FULL platform registry
            // as a sensible default so a fresh edition has email-safe
            // blocks available out of the box. Mustache rows still appear
            // alongside whichever registry surface is active.
            {...(() => {
              const explicit = (blockTemplates as Array<{ render_kind?: string; component_id?: string | null }>)
                .filter((t) => t.render_kind === 'react-email' && typeof t.component_id === 'string' && t.component_id.length > 0)
                .map((t) => t.component_id as string);
              return explicit.length > 0 ? { enabledRegistryComponentIds: explicit } : {};
            })()}
            onChange={setEdition}
            onSave={handleSave}
            onStatusChange={async (newStatus) => {
              setEdition(prev => prev ? { ...prev, status: newStatus } as any : prev);
              if (!isNew && edition) {
                await supabase.from('newsletters_editions').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', edition.id);
                toast.success(`Status changed to ${newStatus}`);
              }
            }}
            isSaving={saving}
          />
        </div>
      )}

      {activeTab === 'details' && (
        <div
          className="-mx-(--margin-x) py-6"
          style={{ padding: '1.5rem calc(var(--margin-x) + 1.5rem)' }}
        >
          <div className="max-w-2xl space-y-5">
            <div>
              <label className="block text-sm font-medium text-[var(--gray-12)] mb-1.5">
                Edition title / subject
              </label>
              <input
                type="text"
                value={edition.subject ?? ''}
                onChange={(e) => setEdition({ ...edition, subject: e.target.value })}
                placeholder="Edition title — also the email subject line"
                className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
              />
              <p className="text-xs text-[var(--gray-9)] mt-1">
                The subject line shown in the recipient&apos;s inbox. Also used as the
                edition&apos;s display name in lists.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-12)] mb-1.5">
                Edition date
              </label>
              <input
                type="date"
                value={edition.edition_date ?? ''}
                onChange={(e) => setEdition({ ...edition, edition_date: e.target.value })}
                className="px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
              />
              <p className="text-xs text-[var(--gray-9)] mt-1">
                The date this edition is logically associated with — used for ordering
                and for the public archive page.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-12)] mb-1.5">
                Preheader
              </label>
              <textarea
                value={edition.preheader ?? ''}
                onChange={(e) => setEdition({ ...edition, preheader: e.target.value })}
                placeholder="Preheader — short preview text shown in the inbox next to the subject (recommended ~80 chars)"
                rows={3}
                className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)] resize-y"
              />
              <p className="text-xs text-[var(--gray-9)] mt-1">
                The short snippet most email clients show next to or below the subject.
                Recommended length: ~80 characters.
              </p>
            </div>

            <div className="pt-2">
              <button
                type="button"
                onClick={() => handleSave()}
                disabled={saving}
                className="px-4 py-2 bg-[var(--accent-9)] hover:bg-[var(--accent-10)] disabled:opacity-50 text-white text-sm font-medium rounded-md transition-colors"
              >
                {saving ? 'Saving…' : 'Save details'}
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'sending' && hasBulkEmailing && (
        <div className="-mx-(--margin-x) py-6" style={{ padding: '1.5rem calc(var(--margin-x) + 1.5rem)' }}>
          <EditionSendingTab
            editionId={edition.id}
            editionDate={edition.edition_date}
            subject={edition.subject || ''}
            collection={collection}
            newsletterSlug={newsletterSlug}
            renderedHtml={edition ? generateNewsletterHtml(
              edition,
              'html',
              collectionMetadata.boilerplateStart || collectionMetadata.boilerplateEnd
                ? { start: (collectionMetadata.boilerplateStart as string) || '', end: (collectionMetadata.boilerplateEnd as string) || '' }
                : undefined,
              // Resolve relative storage paths for the final rendered HTML that recipients see.
              `${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''}/storage/v1/object/public/media`,
            ) : undefined}
          />
        </div>
      )}
    </Page>
  );
}

function freshUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Walk a starter-template's content + nested children, stamping fresh
 * UUIDs at every level. The saved trees strip ids on generation
 * (`build-barebone-trees.ts`) and the curated starters never had ids;
 * minting fresh ones at apply-time keeps Puck's identity tracking
 * correct when the same starter is applied across multiple editions.
 */
function stampIdsRecursive(content: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...content };
  if (Array.isArray(out.children)) {
    out.children = (out.children as Array<{ type: string; props: Record<string, unknown> }>).map((c) => ({
      type: c.type,
      props: stampIdsRecursive({ ...c.props, id: freshUuid() }),
    }));
  }
  return out;
}
