/**
 * Admin surfacing for speaker speaker kits (event Speakers tab):
 *
 * - PromoKitModal — everything in one speaker's generated kit: the three
 *   share images, every post text variant with copy, the tracking link, the
 *   zip download, plus a Regenerate action (resets the kit to 'requested';
 *   the promo-kit sweep rebuilds it within ~2 minutes).
 * - PromoKitSettingsModal — per-event generation mapping: which template
 *   repo and/or brand key this event's kits render with
 *   (speaker_promo_event_config; unset falls back to the module config and
 *   the repo's mapping.json rules).
 *
 * Reads/writes go straight through the admin session — migration 015 grants
 * active platform admins SELECT/UPDATE on kits and CRUD on the config row.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowPathIcon,
  ArrowDownTrayIcon,
  ClipboardIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline';
import { Button, Input, Modal } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { supabase, supabaseUrl } from '@/lib/supabase';

export interface PromoKitRow {
  id: string;
  talk_id: string;
  status: 'requested' | 'generating' | 'ready' | 'failed';
  promo_text_status: 'pending' | 'ready' | 'failed';
  promo_text: {
    options: Array<{ key: string; label: string; body: string }>;
    mention_note?: string;
  } | null;
  promo_text_error: string | null;
  tracking_short_url: string | null;
  cards: Array<{ format: string; storage_path: string; width: number; height: number }> | null;
  zip_storage_path: string | null;
  deck_storage_path: string | null;
  template_version: string | null;
  generated_at: string | null;
  error: string | null;
}

export function mediaPublicUrl(path: string, version?: string | null): string {
  const v = version ? `?v=${encodeURIComponent(version)}` : '';
  return `${supabaseUrl}/storage/v1/object/public/media/${path}${v}`;
}

const CARD_LABELS: Record<string, string> = {
  square: 'Feed post (1200×1200)',
  story: 'Story (1080×1920)',
  landscape: 'Link preview (1200×630)',
};

/** Post text with any URLs picked out in blue. The body is plain text the
 *  speaker pastes elsewhere, so this is display only — Copy still hands over
 *  the original string. */
function linkify(text: string) {
  // Trailing punctuation is sentence, not URL: "…/go/abc." keeps the stop out.
  const parts = text.split(/(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g);
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <span key={i} className="text-blue-600 dark:text-blue-400 break-all">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export function kitStatusBadge(kit: PromoKitRow | undefined): { label: string; className: string; dot: string } {
  if (!kit)
    return {
      label: 'Not generated',
      className: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
      dot: 'bg-gray-300 dark:bg-gray-600',
    };
  switch (kit.status) {
    case 'ready':
      return kit.promo_text_status === 'ready'
        ? { label: 'Ready', className: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300', dot: 'bg-green-500' }
        : { label: 'Ready (no text)', className: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300', dot: 'bg-yellow-500' };
    case 'failed':
      return { label: 'Failed', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300', dot: 'bg-red-500' };
    default:
      return { label: 'Generating…', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300', dot: 'bg-blue-500 animate-pulse' };
  }
}

interface PromoKitModalProps {
  isOpen: boolean;
  onClose: () => void;
  kit: PromoKitRow | null;
  speakerName: string;
  onKitChanged: () => void;
}

export function PromoKitModal({ isOpen, onClose, kit, speakerName, onKitChanged }: PromoKitModalProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  // Which post-text variant the carousel is showing. The four read very
  // similarly at a glance, so only one is on screen at a time.
  const [variantIndex, setVariantIndex] = useState(0);

  const variants = kit?.promo_text?.options ?? [];
  // Guard the index: a regenerated kit can come back with fewer variants
  // than the one the modal was showing.
  const active = variants[variantIndex] ?? variants[0];

  // Reopening for a different speaker, or a regenerated kit, starts at the
  // first variant rather than a stale index that may no longer exist.
  useEffect(() => {
    setVariantIndex(0);
  }, [kit?.id, kit?.generated_at, isOpen]);

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  const handleRegenerate = async () => {
    if (!kit) return;
    setRegenerating(true);
    try {
      const { error } = await supabase
        .from('speaker_promo_kits')
        .update({ status: 'requested', attempts: 0, error: null, promo_text_status: 'pending', promo_text_error: null, ai_run_id: null })
        .eq('id', kit.id);
      if (error) throw error;
      toast.success('Kit queued for regeneration — usually ready within a couple of minutes');
      onKitChanged();
      onClose();
    } catch (err) {
      toast.error(`Failed to queue regeneration: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Speaker kit — ${speakerName}`} size="2xl">
      {!kit ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No kit yet for this speaker. Kits are generated automatically for confirmed talks of upcoming
          events (checked every 2 minutes).
        </p>
      ) : kit.status !== 'ready' ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            {kit.status === 'failed' ? (
              <span>
                Generation failed{kit.error ? `: ${kit.error}` : ''}. Use Regenerate to retry.
              </span>
            ) : (
              <>
                <LoadingSpinner size="xs" />
                <span>Generating — check back shortly.</span>
              </>
            )}
          </div>
          <Button variant="secondary" size="sm" onClick={handleRegenerate} disabled={regenerating}>
            <ArrowPathIcon className="w-4 h-4 mr-1" />
            {regenerating ? 'Queueing…' : 'Regenerate'}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col h-[calc(90vh-9rem)]">
          {/* Fixed height so the modal does not resize as you move between
              variants, and short enough that the modal itself never scrolls.
              The Modal caps at 90vh; above this sit its header, its content
              padding, AND the padding Radix puts on Dialog.Content itself,
              which is what an earlier, tighter figure missed. 9rem clears all
              three with room to spare. */}
          {/* Actions first — the three things an admin actually came to do. */}
          <div className="shrink-0 flex flex-wrap items-center gap-2 pb-4 mb-5 border-b border-gray-100 dark:border-gray-700/50">
            {kit.zip_storage_path && (
              <a href={mediaPublicUrl(kit.zip_storage_path, kit.generated_at)} download="speaker-kit.zip">
                <Button variant="secondary" size="sm" className="whitespace-nowrap">
                  <ArrowDownTrayIcon className="w-4 h-4 mr-1 shrink-0" />
                  Download zip
                </Button>
              </a>
            )}
            {kit.deck_storage_path && (
              <a href={mediaPublicUrl(kit.deck_storage_path, kit.generated_at)} download>
                <Button
                  variant="secondary"
                  size="sm"
                  className="whitespace-nowrap"
                  title="Personalized talk template — opens in PowerPoint or Google Slides (upload to Drive)"
                >
                  <ArrowDownTrayIcon className="w-4 h-4 mr-1 shrink-0" />
                  Slide deck
                </Button>
              </a>
            )}
            <Button
              variant="secondary"
              size="sm"
              className="whitespace-nowrap"
              onClick={handleRegenerate}
              disabled={regenerating}
            >
              <ArrowPathIcon className="w-4 h-4 mr-1 shrink-0" />
              {regenerating ? 'Queueing…' : 'Regenerate'}
            </Button>
            {kit.template_version && (
              <span className="ml-auto text-xs text-gray-400 dark:text-gray-500 truncate">
                Templates: {kit.template_version}
                {kit.generated_at ? ` · generated ${new Date(kit.generated_at).toLocaleString()}` : ''}
              </span>
            )}
          </div>

          <div className="flex-1 min-h-0 flex flex-col gap-5 overflow-y-auto pr-1">
            {/* Share images */}
            {(kit.cards?.length ?? 0) > 0 && (
              <section className="shrink-0">
                <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-2">Share images</h4>
                {/* Fixed height, width follows the aspect ratio. In a 3-column
                    grid each image filled its column, so the 1080x1920 story
                    towered over the 1200x630 link preview and pushed the rest
                    of the modal off screen. */}
                <div className="flex flex-wrap items-start gap-4">
                  {kit.cards!.map((card) => (
                    <a
                      key={card.format}
                      href={mediaPublicUrl(card.storage_path, kit.generated_at)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex flex-col items-center"
                      title={CARD_LABELS[card.format] ?? card.format}
                    >
                      <img
                        src={mediaPublicUrl(card.storage_path, kit.generated_at)}
                        alt={`${CARD_LABELS[card.format] ?? card.format} card for ${speakerName}`}
                        className="h-40 w-auto rounded-lg border border-gray-200 dark:border-gray-700 group-hover:opacity-90"
                      />
                      <p className="mt-1 text-xs text-center text-gray-500 dark:text-gray-400">
                        {CARD_LABELS[card.format] ?? card.format}
                      </p>
                    </a>
                  ))}
                </div>
              </section>
            )}

            {/* Post text — one variant at a time. Stacked, the four read as
                one long wall and it is not obvious they are alternatives. */}
            <section className="flex-1 min-h-[14rem] flex flex-col">
              <h4 className="shrink-0 text-sm font-medium text-gray-900 dark:text-white mb-2">Post text</h4>
              {kit.promo_text_status === 'ready' && variants.length > 0 ? (
                <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                  {/* Tabs. Also the position indicator for the Next button. */}
                  <div
                    role="tablist"
                    aria-label="Post text variants"
                    className="shrink-0 flex flex-wrap gap-1 px-2 pt-2 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700"
                  >
                    {variants.map((option, i) => (
                      <button
                        key={option.key}
                        role="tab"
                        type="button"
                        aria-selected={i === variantIndex}
                        onClick={() => setVariantIndex(i)}
                        // -mb-px pulls the selected tab down over the strip's
                        // bottom border so it reads as joined to the panel
                        // below rather than sitting in a closed box.
                        className={`px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors ${
                          i === variantIndex
                            ? '-mb-px bg-white dark:bg-gray-900 text-gray-900 dark:text-white border border-b-0 border-gray-200 dark:border-gray-700'
                            : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>

                  {active && (
                    <>
                      <pre className="flex-1 min-h-0 whitespace-pre-wrap font-sans text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-900 px-4 py-3 overflow-y-auto">
                        {linkify(active.body)}
                      </pre>
                      <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-t border-gray-100 dark:border-gray-700/50 bg-gray-50 dark:bg-gray-800/30">
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {variantIndex + 1} of {variants.length}
                        </span>
                        <div className="flex items-center gap-2">
                          <Button variant="secondary" size="sm" onClick={() => copy(active.key, active.body)}>
                            {copiedKey === active.key ? (
                              <CheckIcon className="w-4 h-4 mr-1" />
                            ) : (
                              <ClipboardIcon className="w-4 h-4 mr-1" />
                            )}
                            {copiedKey === active.key ? 'Copied' : 'Copy'}
                          </Button>
                          {variants.length > 1 && (
                            <>
                              <Button
                                variant="secondary"
                                size="sm"
                                aria-label="Previous variant"
                                onClick={() => setVariantIndex((i) => (i - 1 + variants.length) % variants.length)}
                              >
                                <ChevronLeftIcon className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                aria-label="Next variant"
                                onClick={() => setVariantIndex((i) => (i + 1) % variants.length)}
                              >
                                <ChevronRightIcon className="w-4 h-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Text unavailable{kit.promo_text_error ? ` (${kit.promo_text_error})` : ''} — the kit shipped
                  with images and the tracking link. Regenerate to retry the text.
                </p>
              )}
              {kit.promo_text?.mention_note && (
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{kit.promo_text.mention_note}</p>
              )}
            </section>

          </div>

          {/* Pinned below the scroll region. It belongs to every variant, and
            on a short screen it must not fall off the bottom. */}
          {kit.tracking_short_url && (
            // Its own area, not a continuation of the post text above. The
            // mention note sits tight under the carousel, so this needs a
            // clear gap and a rule rather than the default flow spacing.
            <section className="shrink-0 mt-4 pt-4 border-t border-gray-100 dark:border-gray-700/50">
              <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-2">Tracking link</h4>
              <div className="flex items-stretch gap-2">
                {/* className lands on the inner <input>; the root div is what
                    participates in this flex row, so stretch it via classNames. */}
                <Input
                  value={kit.tracking_short_url}
                  readOnly
                  className="w-full"
                  classNames={{ root: 'flex-1 min-w-0' }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  className="whitespace-nowrap"
                  // Radix Themes sets the button height from its own CSS
                  // variable, which a Tailwind height class loses to. An
                  // inline style is what actually matches the field.
                  style={{ height: 'auto', alignSelf: 'stretch' }}
                  onClick={() => copy('link', kit.tracking_short_url!)}
                >
                  {copiedKey === 'link' ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

interface PromoKitSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  eventUuid: string;
}

export function PromoKitSettingsModal({ isOpen, onClose, eventUuid }: PromoKitSettingsModalProps) {
  const [templateRepo, setTemplateRepo] = useState('');
  const [brandKey, setBrandKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    supabase
      .from('speaker_promo_event_config')
      .select('template_repo, brand_key')
      .eq('event_uuid', eventUuid)
      .maybeSingle()
      .then(({ data }) => {
        setTemplateRepo(data?.template_repo ?? '');
        setBrandKey(data?.brand_key ?? '');
      })
      .then(undefined, () => toast.error('Failed to load speaker kit settings'))
      .then(() => setLoading(false));
  }, [isOpen, eventUuid]);

  const handleSave = async () => {
    const repo = templateRepo.trim();
    const brand = brandKey.trim();
    if (repo && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(#[\w./-]+)?$/.test(repo)) {
      toast.error('Template repo must be https://github.com/<org>/<repo>[#ref]');
      return;
    }
    if (brand && !/^[\w-]{1,64}$/.test(brand)) {
      toast.error('Brand key must match brands/<key>.json in the template repo (letters, digits, - _)');
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from('speaker_promo_event_config')
        .upsert(
          { event_uuid: eventUuid, template_repo: repo || null, brand_key: brand || null },
          { onConflict: 'event_uuid' },
        );
      if (error) throw error;
      toast.success('Speaker kit settings saved — applies to the next (re)generation');
      onClose();
    } catch (err) {
      toast.error(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Speaker kit settings" size="md">
      {loading ? (
        <div className="py-6 flex justify-center"><LoadingSpinner size="sm" /></div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
              Template repo override
            </label>
            <Input
              value={templateRepo}
              onChange={(e) => setTemplateRepo(e.target.value)}
              placeholder="https://github.com/gatewaze/gatewaze-template-speaker-cards#main"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Git repo holding the card templates, brand colorways, and event→brand mapping for this
              event&apos;s kits. Leave empty to use the platform default.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
              Brand override
            </label>
            <Input value={brandKey} onChange={(e) => setBrandKey(e.target.value)} placeholder="e.g. finance" />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Pins this event to a brand key (brands/&lt;key&gt;.json in the template repo). Leave empty to
              resolve via the repo&apos;s mapping.json rules (e.g. title contains &quot;finance&quot;).
            </p>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Changes apply the next time a kit is generated or regenerated (use Regenerate in a
            speaker&apos;s kit to re-render with new settings).
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
