/**
 * Page editor route — /sites/:siteSlug/pages/:pageId
 *
 * Loads the site + page + (for sites, always) the templates content
 * schema, then mounts the <PageEditor> dispatch component, which renders
 * the schema-driven editor (sites are uniformly theme_kind='website').
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ArrowLeftIcon, DocumentIcon, ChartBarIcon, PencilSquareIcon, UserGroupIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Button, Card, Tabs } from '@/components/ui';
import type { Tab } from '@/components/ui/Tabs';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { PageEditor, type PageEditorContentSchema } from '../page-editor';
import { PageAnalytics } from './PageAnalytics';
import { VariantEditor } from '../components/VariantEditor';
import { PagePersonalizationMatrix } from '../components/PagePersonalizationMatrix';
import { SitesService, PagesService } from '../services/sitesService';
import { PageVariantsService, type PageVariant } from '../services/pageVariantsService';
import { PersonasService, type Persona } from '../services/personasService';
import { jsonPointerToFieldPath } from '../lib/field-path';
import { getSchemaAtPointer } from '../schema-editor/walk-schema';
import type { PageRow, SiteRow } from '../../types';
import { supabase } from '@/lib/supabase';

const VALID_TABS = ['editor', 'personalization', 'analytics'] as const;
type TabKey = (typeof VALID_TABS)[number];

export default function PageEditorPage() {
  const { siteSlug, pageId } = useParams<{ siteSlug: string; pageId: string }>();
  const navigate = useNavigate();

  const [site, setSite] = useState<SiteRow | null>(null);
  const [page, setPage] = useState<PageRow | null>(null);
  const [contentSchema, setContentSchema] = useState<PageEditorContentSchema | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>('editor');
  const [variantPointer, setVariantPointer] = useState<string | null>(null);
  const [variants, setVariants] = useState<PageVariant[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);

  async function loadVariantsAndPersonas(siteId: string, pageIdToLoad: string) {
    const [vRes, pRes] = await Promise.all([
      PageVariantsService.list(pageIdToLoad),
      PersonasService.list(siteId),
    ]);
    if (vRes.error) toast.error(`Variants: ${vRes.error}`);
    if (pRes.error) toast.error(`Personas: ${pRes.error}`);
    setVariants(vRes.variants);
    setPersonas(pRes.personas);
  }

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!siteSlug || !pageId) return;
      setLoading(true);

      const siteRes = await SitesService.getSite(siteSlug);
      if (cancelled) return;
      if (siteRes.error || !siteRes.site) {
        toast.error(siteRes.error ?? 'Site not found');
        navigate('/sites');
        return;
      }

      const pageRes = await PagesService.getPage(pageId);
      if (cancelled) return;
      if (pageRes.error || !pageRes.page) {
        toast.error(pageRes.error ?? 'Page not found');
        navigate(`/sites/${siteSlug}`);
        return;
      }

      // For website-kind sites, load the matching content schema row.
      let schema: PageEditorContentSchema | null = null;
      if (siteRes.site.theme_kind === 'website' && pageRes.page.content_schema_version) {
        const { data, error } = await supabase
          .from('templates_content_schemas')
          .select('schema_json, version')
          .eq('library_id', pageRes.page.templates_library_id)
          .eq('version', pageRes.page.content_schema_version)
          .maybeSingle();
        if (!cancelled) {
          if (error) toast.error(`Schema load: ${error.message}`);
          if (data) schema = { schema_json: data.schema_json as Record<string, unknown>, version: data.version as number };
        }
      }

      if (!cancelled) {
        setSite(siteRes.site);
        setPage(pageRes.page);
        setContentSchema(schema);
        setLoading(false);
        void loadVariantsAndPersonas(siteRes.site.id, pageRes.page.id);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [siteSlug, pageId, navigate]);

  if (loading || !site || !page) {
    return (
      <Page title="Loading...">
        <LoadingSpinner />
      </Page>
    );
  }

  return (
    <Page title={page.title}>
      <div className="space-y-4">
        <Card>
          <div className="flex items-center gap-3 p-4">
            <Button variant="ghost" onClick={() => navigate(`/sites/${site.slug}`)} aria-label="Back to site">
              <ArrowLeftIcon className="size-4" />
            </Button>
            <DocumentIcon className="size-5 text-[var(--accent-9)]" />
            <div>
              <h2 className="text-lg font-semibold">{page.title}</h2>
              <div className="text-xs text-[var(--gray-a8)]">
                <span className="font-mono">{page.full_path}</span>
                <span className="mx-2">·</span>
                <span>{site.name}</span>
              </div>
            </div>
          </div>
        </Card>

        <Tabs
          value={activeTab}
          onChange={(t: string) => setActiveTab(t as TabKey)}
          tabs={[
            { id: 'editor', label: 'Editor', icon: <PencilSquareIcon className="size-4" /> },
            { id: 'personalization', label: 'Personalization', icon: <UserGroupIcon className="size-4" /> },
            { id: 'analytics', label: 'Analytics', icon: <ChartBarIcon className="size-4" /> },
          ] as Tab[]}
        />

        {activeTab === 'editor' && (
          <Card>
            <div className="p-4">
              <PageEditor
                site={{ id: site.id, slug: site.slug, theme_kind: site.theme_kind }}
                page={{
                  id: page.id,
                  full_path: page.full_path,
                  content: page.content,
                  content_schema_version: page.content_schema_version,
                  composition_mode: page.composition_mode,
                }}
                contentSchema={contentSchema}
                baseCommitSha={null}
                onPersonalize={(pointer) => setVariantPointer(pointer)}
              />
            </div>
          </Card>
        )}

        {activeTab === 'personalization' && contentSchema && (
          <Card>
            <div className="p-4">
              <PagePersonalizationMatrix
                schema={contentSchema.schema_json}
                defaultContent={(page.content ?? {}) as Record<string, unknown>}
                personas={personas}
                variants={variants}
                onEditField={(pointer) => setVariantPointer(pointer)}
              />
            </div>
          </Card>
        )}

        {activeTab === 'personalization' && !contentSchema && (
          <Card>
            <div className="p-6 text-center text-sm text-(--gray-9)">
              Personalization is available for schema-mode pages once a content schema is loaded.
            </div>
          </Card>
        )}

        {activeTab === 'analytics' && (
          <PageAnalytics siteId={site.id} pagePath={page.full_path} />
        )}

        {variantPointer !== null && contentSchema && (
          <VariantEditor
            pageId={page.id}
            siteId={site.id}
            fieldPath={jsonPointerToFieldPath(variantPointer)}
            fieldLabel={variantPointer}
            fieldSchema={getSchemaAtPointer(contentSchema.schema_json, variantPointer)}
            onClose={() => {
              setVariantPointer(null);
              void loadVariantsAndPersonas(site.id, page.id);
            }}
          />
        )}
      </div>
    </Page>
  );
}
