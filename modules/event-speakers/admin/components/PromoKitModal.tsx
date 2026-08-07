/**
 * Admin surfacing for speaker promo kits (event Speakers tab):
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
import { ArrowPathIcon, ArrowDownTrayIcon, ClipboardIcon, CheckIcon } from '@heroicons/react/24/outline';
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
  template_version: string | null;
  generated_at: string | null;
  error: string | null;
}

export function mediaPublicUrl(path: string): string {
  return `${supabaseUrl}/storage/v1/object/public/media/${path}`;
}

const CARD_LABELS: Record<string, string> = {
  square: 'Feed post (1200×1200)',
  story: 'Story (1080×1920)',
  landscape: 'Link preview (1200×630)',
};

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
    <Modal isOpen={isOpen} onClose={onClose} title={`Promo kit — ${speakerName}`} size="lg">
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
        <div className="space-y-6 max-h-[70vh] overflow-y-auto pr-1">
          {/* Share images */}
          {(kit.cards?.length ?? 0) > 0 && (
            <section>
              <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-2">Share images</h4>
              <div className="grid grid-cols-3 gap-3">
                {kit.cards!.map((card) => (
                  <a
                    key={card.format}
                    href={mediaPublicUrl(card.storage_path)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block group"
                    title={CARD_LABELS[card.format] ?? card.format}
                  >
                    <img
                      src={mediaPublicUrl(card.storage_path)}
                      alt={`${CARD_LABELS[card.format] ?? card.format} card for ${speakerName}`}
                      className="rounded-lg border border-gray-200 dark:border-gray-700 w-full h-auto group-hover:opacity-90"
                    />
                    <p className="mt-1 text-xs text-center text-gray-500 dark:text-gray-400">
                      {CARD_LABELS[card.format] ?? card.format}
                    </p>
                  </a>
                ))}
              </div>
            </section>
          )}

          {/* Post text variants */}
          <section>
            <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-2">Post text</h4>
            {kit.promo_text_status === 'ready' && kit.promo_text ? (
              <div className="space-y-3">
                {kit.promo_text.options.map((option) => (
                  <div key={option.key} className="rounded-lg border border-gray-200 dark:border-gray-700">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-gray-700/50">
                      <span className="text-xs font-medium text-gray-700 dark:text-gray-200">{option.label}</span>
                      <Button variant="secondary" size="sm" onClick={() => copy(option.key, option.body)}>
                        {copiedKey === option.key ? (
                          <CheckIcon className="w-4 h-4 mr-1" />
                        ) : (
                          <ClipboardIcon className="w-4 h-4 mr-1" />
                        )}
                        {copiedKey === option.key ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                    <pre className="whitespace-pre-wrap font-sans text-xs text-gray-600 dark:text-gray-300 px-3 py-2 max-h-44 overflow-y-auto">
                      {option.body}
                    </pre>
                  </div>
                ))}
                {kit.promo_text.mention_note && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">{kit.promo_text.mention_note}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Text unavailable{kit.promo_text_error ? ` (${kit.promo_text_error})` : ''} — the kit shipped
                with images and the tracking link. Regenerate to retry the text.
              </p>
            )}
          </section>

          {/* Tracking link */}
          {kit.tracking_short_url && (
            <section>
              <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-2">Tracking link</h4>
              <div className="flex items-center gap-2">
                {/* className lands on the inner <input>; the root div is what
                    participates in this flex row, so stretch it via classNames. */}
                <Input
                  value={kit.tracking_short_url}
                  readOnly
                  className="w-full"
                  classNames={{ root: 'flex-1 min-w-0' }}
                />
                <Button variant="secondary" size="sm" className="whitespace-nowrap" onClick={() => copy('link', kit.tracking_short_url!)}>
                  {copiedKey === 'link' ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </section>
          )}

          {/* Footer actions */}
          <div className="pt-3 border-t border-gray-100 dark:border-gray-700/50 space-y-2">
            <div className="flex items-center gap-2">
              {kit.zip_storage_path && (
                <a href={mediaPublicUrl(kit.zip_storage_path)} download>
                  <Button variant="secondary" size="sm" className="whitespace-nowrap">
                    <ArrowDownTrayIcon className="w-4 h-4 mr-1 shrink-0" />
                    Download zip
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
            </div>
            {kit.template_version && (
              <p className="text-xs text-gray-400 dark:text-gray-500 truncate">
                Templates: {kit.template_version}
                {kit.generated_at ? ` · generated ${new Date(kit.generated_at).toLocaleString()}` : ''}
              </p>
            )}
          </div>
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
      .then(undefined, () => toast.error('Failed to load promo kit settings'))
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
      toast.success('Promo kit settings saved — applies to the next (re)generation');
      onClose();
    } catch (err) {
      toast.error(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Promo kit settings" size="md">
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
