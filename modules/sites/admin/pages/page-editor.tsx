/**
 * Page editor route — /sites/:siteSlug/pages/:pageId
 *
 * Loads the site + page + (for sites, always) the templates content
 * schema, then mounts the <PageEditor> dispatch component, which renders
 * the schema-driven editor (sites are uniformly theme_kind='website').
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ArrowLeftIcon, DocumentIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Button, Card } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { PageEditor, type PageEditorContentSchema } from '../page-editor';
import { SitesService, PagesService } from '../services/sitesService';
import type { PageRow, SiteRow } from '../../types';
import { supabase } from '@/lib/supabase';

export default function PageEditorPage() {
  const { siteSlug, pageId } = useParams<{ siteSlug: string; pageId: string }>();
  const navigate = useNavigate();

  const [site, setSite] = useState<SiteRow | null>(null);
  const [page, setPage] = useState<PageRow | null>(null);
  const [contentSchema, setContentSchema] = useState<PageEditorContentSchema | null>(null);
  const [loading, setLoading] = useState(true);

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

        <Card>
          <div className="p-4">
            <PageEditor
              site={{ id: site.id, slug: site.slug, theme_kind: site.theme_kind }}
              page={{
                id: page.id,
                full_path: page.full_path,
                content: page.content,
                content_schema_version: page.content_schema_version,
              }}
              contentSchema={contentSchema}
              baseCommitSha={null}
              HtmlBlockListEditor={() => (
                <div className="p-6 rounded-lg border border-[var(--gray-a5)] bg-[var(--gray-a2)] text-sm">
                  <p className="font-medium mb-2">HTML block-list editor not yet wired here</p>
                  <p className="text-[var(--gray-a8)]">
                    For theme_kind=html, the block-list editor lives in the gatewaze admin app at{' '}
                    <span className="font-mono">/newsletters/editor</span> (which now uses the same
                    <span className="font-mono"> templates_block_defs</span> the sites module reads
                    from). A site-specific block editor is a follow-up.
                  </p>
                </div>
              )}
            />
          </div>
        </Card>
      </div>
    </Page>
  );
}
