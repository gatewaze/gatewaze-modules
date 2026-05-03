/**
 * Settings tab — name + description + per-site config (analytics, SEO defaults).
 *
 * Slug + theme_kind are immutable post-create (DB triggers enforce this);
 * we don't even render those as editable inputs.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, Input, Select } from '@/components/ui';
import { useForm } from 'react-hook-form';
import { SitesService } from '../services/sitesService';
import type { SiteRow } from '../../types';

interface SettingsForm {
  name: string;
  description: string;
  defaultTitle: string;
  defaultDescription: string;
  ogImageUrl: string;
  robots: 'index' | 'noindex';
  analyticsProvider: 'plausible' | 'fathom' | 'umami' | 'ga4' | 'none';
  analyticsSiteId: string;
}

export function SiteSettingsTab({ site, onSiteUpdated }: { site: SiteRow; onSiteUpdated: (s: SiteRow) => void }) {
  const [submitting, setSubmitting] = useState(false);

  const { register, handleSubmit, formState: { errors } } = useForm<SettingsForm>({
    defaultValues: {
      name: site.name,
      description: site.description ?? '',
      defaultTitle: site.config?.seo?.defaultTitle ?? '',
      defaultDescription: site.config?.seo?.defaultDescription ?? '',
      ogImageUrl: site.config?.seo?.ogImageUrl ?? '',
      robots: site.config?.seo?.robots ?? 'index',
      analyticsProvider: site.config?.analytics?.provider ?? 'none',
      analyticsSiteId: site.config?.analytics?.siteId ?? '',
    },
  });

  const onSubmit = async (data: SettingsForm) => {
    setSubmitting(true);
    const { site: updated, error } = await SitesService.updateSite(site.id, {
      name: data.name,
      description: data.description || null,
      config: {
        ...site.config,
        seo: {
          defaultTitle: data.defaultTitle || undefined,
          defaultDescription: data.defaultDescription || undefined,
          ogImageUrl: data.ogImageUrl || undefined,
          robots: data.robots,
        },
        analytics:
          data.analyticsProvider === 'none'
            ? { provider: 'none' }
            : { provider: data.analyticsProvider, siteId: data.analyticsSiteId || undefined },
      },
    });
    setSubmitting(false);
    if (error || !updated) {
      toast.error(`Save failed: ${error}`);
      return;
    }
    toast.success('Saved');
    onSiteUpdated(updated);
  };

  return (
    <Card>
      <form onSubmit={handleSubmit(onSubmit)} className="p-4 space-y-6">
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-[var(--gray-12)]">Identity</h3>
          <Input label="Name" {...register('name', { required: 'Required' })} error={errors.name?.message} />
          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Description</label>
            <textarea
              {...register('description')}
              rows={2}
              className="w-full px-3 py-2 bg-transparent border border-[var(--gray-a5)] rounded-lg focus:outline-none focus:border-[var(--accent-9)] text-[var(--gray-12)]"
            />
          </div>
          <p className="text-xs text-[var(--gray-a8)]">
            Slug (<span className="font-mono">{site.slug}</span>) and theme_kind (
            <span className="font-mono">{site.theme_kind}</span>) cannot be changed.
          </p>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-[var(--gray-12)]">SEO defaults</h3>
          <Input label="Default page title" {...register('defaultTitle')} placeholder="My Site" />
          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Default description</label>
            <textarea
              {...register('defaultDescription')}
              rows={2}
              className="w-full px-3 py-2 bg-transparent border border-[var(--gray-a5)] rounded-lg focus:outline-none focus:border-[var(--accent-9)] text-[var(--gray-12)]"
            />
          </div>
          <Input label="Default OpenGraph image URL" {...register('ogImageUrl')} placeholder="https://..." />
          <Select
            label="Robots"
            {...register('robots')}
            data={[
              { value: 'index', label: 'index — search engines may index' },
              { value: 'noindex', label: 'noindex — exclude from search engines' },
            ]}
          />
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-[var(--gray-12)]">Analytics</h3>
          <Select
            label="Provider"
            {...register('analyticsProvider')}
            data={[
              { value: 'none', label: 'None' },
              { value: 'plausible', label: 'Plausible' },
              { value: 'fathom', label: 'Fathom' },
              { value: 'umami', label: 'Umami' },
              { value: 'ga4', label: 'Google Analytics 4' },
            ]}
          />
          <Input label="Site ID / measurement ID" {...register('analyticsSiteId')} placeholder="(per-provider format)" />
        </section>

        <div className="flex justify-end">
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Saving...' : 'Save settings'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
