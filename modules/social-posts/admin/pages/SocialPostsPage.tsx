import { useCallback, useEffect, useMemo, useState } from 'react';
import { Checkbox, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import type { Platform } from '../../lib/formats';
import type { PoolType } from '../../lib/pool-types';
import { ContentPicker, keyOf, type SelectedItem } from '../components/ContentPicker';
import { Composer, EMPTY_COMPOSER, type ComposerState } from '../components/Composer';
import { DraftsList } from '../components/DraftsList';
import { socialPostsService, type Draft } from '../utils/socialPostsService';

// LinkedIn is the only platform today; the registry in lib/formats.ts is
// where X and Bluesky are added, and this becomes a picker then.
const PLATFORM: Platform = 'linkedin';

const SOURCE_LABEL: Record<PoolType, string> = { blog_post: 'Blog post', video: 'Video', event: 'Event', sr_item: 'Resource' };

/**
 * Social Posts: pick curated items, generate a LinkedIn post, edit, copy,
 * save as a draft. No router navigation inside the page, so it behaves the
 * same in the standalone admin and in the admin embed.
 */
export default function SocialPostsPage() {
  const [tab, setTab] = useState<'write' | 'drafts'>('write');
  // Insertion order is the order the post covers the items in.
  const [selected, setSelected] = useState<Map<string, SelectedItem>>(new Map());
  const [composer, setComposer] = useState<ComposerState>(EMPTY_COMPOSER);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const loadDrafts = useCallback(async () => {
    setDraftsError(null);
    try {
      setDrafts(await socialPostsService.listDrafts(showArchived ? ['draft', 'ready', 'scheduled', 'posted', 'archived'] : undefined));
    } catch (e) {
      setDraftsError(e instanceof Error ? e.message : 'Could not load drafts');
      setDrafts([]);
    }
  }, [showArchived]);

  useEffect(() => { void loadDrafts(); }, [loadDrafts]);

  const toggle = useCallback((item: SelectedItem) => {
    // A saved draft keeps the sources it was written from.
    if (composer.draftId) return;
    setSelected((prev) => {
      const next = new Map(prev);
      const k = keyOf(item);
      if (next.has(k)) next.delete(k);
      else next.set(k, item);
      return next;
    });
  }, [composer.draftId]);

  const openDraft = useCallback((d: Draft) => {
    const next = new Map<string, SelectedItem>();
    for (const s of d.sources.slice().sort((a, b) => a.position - b.position)) {
      next.set(keyOf(s), { content_type: s.content_type, content_id: s.content_id, title: s.title ?? '(untitled)', typeLabel: SOURCE_LABEL[s.content_type] ?? 'Item', url: s.url });
    }
    setSelected(next);
    setComposer({
      ...EMPTY_COMPOSER,
      draftId: d.id,
      draftStatus: d.status,
      format: d.format,
      instructions: d.instructions ?? '',
      text: d.body,
      hashtags: d.hashtags,
      mentions: d.mentions,
      model: d.ai_model,
      generated: !!d.generated_at,
    });
    setTab('write');
  }, []);

  // A status change from the Drafts tab must reach the composer when that
  // draft is the one open there.
  const draftChanged = useCallback((d: Draft) => {
    setComposer((c) => (c.draftId === d.id ? { ...c, draftStatus: d.status } : c));
    void loadDrafts();
  }, [loadDrafts]);

  const reloadDrafts = useCallback(() => { void loadDrafts(); }, [loadDrafts]);

  const startNew = useCallback(() => {
    setSelected(new Map());
    setComposer(EMPTY_COMPOSER);
  }, []);

  const selectedList = useMemo(() => Array.from(selected.values()), [selected]);
  const activeDrafts = drafts?.filter((d) => d.status !== 'archived').length ?? 0;

  return (
    <Page title="Social Posts">
      <WorkspaceLayout
        title="Social Posts"
        tabs={[
          { id: 'write', label: 'Write' },
          { id: 'drafts', label: 'Drafts', count: activeDrafts },
        ]}
        activeTabId={tab}
        onTabChange={(t) => setTab(t === 'drafts' ? 'drafts' : 'write')}
      >
        <div className="space-y-5">
          {tab === 'write' && (
            <p className="text-sm text-[var(--gray-a10)]">
              Write LinkedIn posts from curated content. Pick items, pick a format, generate, then edit and save the draft.
            </p>
          )}

          {tab === 'write' ? (
            <div className="grid gap-5 lg:grid-cols-5">
              <div className="lg:col-span-3">
                <ContentPicker selected={selected} onToggle={toggle} />
              </div>
              <div className="lg:col-span-2">
                <Composer
                  platform={PLATFORM}
                  selected={selectedList}
                  onRemove={toggle}
                  state={composer}
                  setState={setComposer}
                  onSaved={reloadDrafts}
                  onNew={startNew}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Checkbox
                label="Show archived"
                checked={showArchived}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setShowArchived(e.target.checked)}
              />
              <DraftsList drafts={drafts} error={draftsError} onOpen={openDraft} onChanged={draftChanged} />
            </div>
          )}
        </div>
      </WorkspaceLayout>
    </Page>
  );
}
