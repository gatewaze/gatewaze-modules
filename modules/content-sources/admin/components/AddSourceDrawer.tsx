import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ExclamationTriangleIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { Badge, Button, Modal } from '@/components/ui';
import {
  createSource,
  patchSource,
  resolveSite,
  DiscoveryApiError,
  SOURCE_KINDS,
  type CreateSourceBody,
  type DiscoverySource,
  type FeedCandidate,
  type PatchSourceBody,
  type SourceKind,
} from '../utils/discoveryService';

export interface AddSourceDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the created or updated row. */
  onSaved: (source: DiscoverySource) => void;
  /** Existing foundations, offered as datalist suggestions. */
  foundations: string[];
  /** When set, the drawer edits this source (details only, no resolve step). */
  source?: DiscoverySource | null;
}

interface Details {
  foundation: string;
  project: string;
  content_category: string;
  note: string;
  kind: SourceKind;
  feed_url: string;
  path_prefix: string;
}

/** Sentinel for "save without a feed" (kind html, always lands pending: the feed scraper cannot run it). */
const NO_FEED = '__no_feed__';

const inputClass =
  'w-full px-3 py-1.5 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]';
const labelClass = 'block text-xs font-medium text-[var(--gray-11)] mb-1';

function formatDate(iso: string | null): string {
  if (!iso) return 'no dated entries';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function detailsFromSource(s: DiscoverySource | null | undefined): Details {
  return {
    foundation: s?.foundation ?? '',
    project: s?.project ?? '',
    content_category: s?.content_category ?? '',
    note: s?.note ?? '',
    kind: s?.kind ?? 'feed',
    feed_url: s?.feed_url ?? '',
    path_prefix: s?.path_prefix ?? '',
  };
}

function kindFromCandidate(c: FeedCandidate): SourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(c.kind) ? (c.kind as SourceKind) : 'feed';
}

export function AddSourceDrawer({ isOpen, onClose, onSaved, foundations, source }: AddSourceDrawerProps) {
  const editing = Boolean(source);
  const [step, setStep] = useState<1 | 2>(editing ? 2 : 1);

  // Step 1
  const [siteUrl, setSiteUrl] = useState('');
  const [resolving, setResolving] = useState(false);
  const [candidates, setCandidates] = useState<FeedCandidate[] | null>(null);
  const [resolveErrors, setResolveErrors] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string>('');

  // Step 2
  const [details, setDetails] = useState<Details>(() => detailsFromSource(source));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; existingId?: string } | null>(null);

  // Reset whenever the drawer opens or the target row changes.
  useEffect(() => {
    if (!isOpen) return;
    setStep(source ? 2 : 1);
    setSiteUrl(source?.site_url ?? '');
    setResolving(false);
    setCandidates(null);
    setResolveErrors([]);
    setChosen('');
    setDetails(detailsFromSource(source));
    setSaving(false);
    setError(null);
  }, [isOpen, source]);

  const chosenCandidate = useMemo(
    () => candidates?.find((c) => c.feed_url === chosen) ?? null,
    [candidates, chosen],
  );

  async function findFeed(e?: FormEvent) {
    e?.preventDefault();
    const url = siteUrl.trim();
    if (!url) return;
    setResolving(true);
    setError(null);
    setCandidates(null);
    setResolveErrors([]);
    try {
      const r = await resolveSite(url);
      setSiteUrl(r.site_url || url);
      setCandidates(r.candidates);
      setResolveErrors(r.errors ?? []);
      setChosen(r.candidates[0]?.feed_url ?? NO_FEED);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err) });
    } finally {
      setResolving(false);
    }
  }

  function goToDetails() {
    if (!candidates) return;
    const c = chosenCandidate;
    setDetails({
      foundation: '',
      project: c?.feed_title?.trim() ?? '',
      content_category: '',
      note: '',
      kind: c ? kindFromCandidate(c) : 'html',
      feed_url: c?.feed_url ?? '',
      path_prefix: '',
    });
    setError(null);
    setStep(2);
  }

  function update<K extends keyof Details>(key: K, value: Details[K]) {
    setDetails((d) => ({ ...d, [key]: value }));
  }

  const nullIfBlank = (v: string) => (v.trim() === '' ? null : v.trim());

  async function save(e?: FormEvent) {
    e?.preventDefault();
    setSaving(true);
    setError(null);
    try {
      let saved: DiscoverySource;
      if (source) {
        const body: PatchSourceBody = {};
        const orig = detailsFromSource(source);
        if (details.foundation.trim() && details.foundation.trim() !== orig.foundation) body.foundation = details.foundation.trim();
        if (details.project.trim() && details.project.trim() !== orig.project) body.project = details.project.trim();
        if (details.content_category !== orig.content_category) body.content_category = nullIfBlank(details.content_category);
        if (details.note !== orig.note) body.note = nullIfBlank(details.note);
        if (details.kind !== orig.kind) body.kind = details.kind;
        if (details.feed_url.trim() !== orig.feed_url) body.feed_url = nullIfBlank(details.feed_url);
        if (details.path_prefix.trim() !== orig.path_prefix) body.path_prefix = nullIfBlank(details.path_prefix);
        if (Object.keys(body).length === 0) {
          onClose();
          return;
        }
        saved = await patchSource(source.id, body);
      } else {
        const body: CreateSourceBody = {
          site_url: siteUrl.trim(),
          kind: details.kind,
          feed_url: details.kind === 'html' ? null : nullIfBlank(details.feed_url),
          path_prefix: details.kind === 'sitemap' ? nullIfBlank(details.path_prefix) : null,
          foundation: nullIfBlank(details.foundation),
          project: nullIfBlank(details.project),
          content_category: nullIfBlank(details.content_category),
          note: nullIfBlank(details.note),
        };
        saved = await createSource(body);
      }
      onSaved(saved);
      onClose();
    } catch (err) {
      if (err instanceof DiscoveryApiError) {
        const existingId = (err.details as { id?: string } | undefined)?.id;
        setError({ message: err.message, existingId });
      } else {
        setError({ message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setSaving(false);
    }
  }

  const title = editing ? `Edit ${source?.project ?? 'source'}` : step === 1 ? 'Add source' : 'Add source: details';
  const foundationListId = 'discovery-foundation-options';

  const footer = step === 1 ? (
    <div className="flex items-center justify-between gap-2">
      <Button variant="outline" onClick={onClose}>Cancel</Button>
      <Button onClick={goToDetails} disabled={!candidates || !chosen}>Next</Button>
    </div>
  ) : (
    <div className="flex items-center justify-between gap-2">
      <div>
        {!editing && (
          <Button variant="ghost" onClick={() => { setStep(1); setError(null); }} disabled={saving}>Back</Button>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={() => save()} disabled={saving || (!editing && details.kind !== 'html' && !details.feed_url.trim())}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Save source'}
        </Button>
      </div>
    </div>
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="lg" footer={footer}>
      {error && (
        <div role="alert" className="mb-3 p-3 rounded-md border border-[var(--red-a6)] bg-[var(--red-a3)] text-sm text-[var(--red-11)]">
          {error.message}
          {error.existingId && (
            <div className="mt-1 text-xs text-[var(--red-11)]">
              Existing source id: <code className="font-mono">{error.existingId}</code>
            </div>
          )}
        </div>
      )}

      {step === 1 && (
        <form onSubmit={findFeed} className="space-y-4">
          <div>
            <label htmlFor="discovery-site-url" className={labelClass}>Site URL</label>
            <div className="flex gap-2">
              <input
                id="discovery-site-url"
                type="url"
                inputMode="url"
                autoFocus
                required
                placeholder="https://blog.example.org"
                className={inputClass}
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                disabled={resolving}
              />
              <Button type="submit" disabled={resolving || !siteUrl.trim()}>
                <MagnifyingGlassIcon className="size-4" aria-hidden="true" />
                {resolving ? 'Looking…' : 'Find feed'}
              </Button>
            </div>
            <p className="mt-1 text-xs text-[var(--gray-10)]">
              https only. We read the page for feed links, then try the usual feed paths.
            </p>
          </div>

          {resolving && (
            <div className="text-sm text-[var(--gray-11)]" aria-live="polite">Checking the site and up to a dozen feed paths. This can take several seconds.</div>
          )}

          {candidates && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium mb-1">
                {candidates.length === 0 ? 'No feed found' : `${candidates.length} feed${candidates.length === 1 ? '' : 's'} found`}
              </legend>
              {candidates.map((c) => (
                <label
                  key={c.feed_url}
                  className={`flex gap-3 items-start p-3 rounded-md border cursor-pointer ${chosen === c.feed_url ? 'border-[var(--accent-8)] bg-[var(--accent-a2)]' : 'border-[var(--gray-a6)]'}`}
                >
                  <input
                    type="radio"
                    name="discovery-candidate"
                    className="mt-1"
                    checked={chosen === c.feed_url}
                    onChange={() => setChosen(c.feed_url)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sm">{c.feed_title || '(untitled feed)'}</span>
                      <Badge variant="soft" color="neutral">{c.kind}</Badge>
                      {c.cross_domain && (
                        <Badge variant="soft" color="warning">
                          <ExclamationTriangleIcon className="size-3 mr-1" aria-hidden="true" />cross-domain
                        </Badge>
                      )}
                      {c.is_root_index && <Badge variant="soft" color="neutral">root index.xml</Badge>}
                    </div>
                    <div className="text-xs text-[var(--gray-11)] mt-0.5 break-all">{c.feed_url}</div>
                    <div className="text-xs text-[var(--gray-10)] mt-0.5">
                      {c.entry_count} {c.entry_count === 1 ? 'entry' : 'entries'} · newest {formatDate(c.newest_entry_at)} · via {c.found_via}
                    </div>
                    {c.cross_domain && (
                      <div className="text-xs text-[var(--orange-11)] mt-1">
                        This feed is on a different domain than the site. Check it really belongs to this site before saving; saving it here activates it.
                      </div>
                    )}
                    {c.is_root_index && (
                      <div className="text-xs text-[var(--gray-10)] mt-1">
                        A site-wide Hugo feed usually carries docs and product pages too; prefer a section feed when one is listed.
                      </div>
                    )}
                  </div>
                </label>
              ))}

              <label
                className={`flex gap-3 items-start p-3 rounded-md border cursor-pointer ${chosen === NO_FEED ? 'border-[var(--accent-8)] bg-[var(--accent-a2)]' : 'border-[var(--gray-a6)]'}`}
              >
                <input
                  type="radio"
                  name="discovery-candidate"
                  className="mt-1"
                  checked={chosen === NO_FEED}
                  onChange={() => setChosen(NO_FEED)}
                />
                <div className="text-sm">
                  <div className="font-medium">Save without a feed</div>
                  <div className="text-xs text-[var(--gray-10)] mt-0.5">
                    Kept as an HTML target with no feed; the scraper has nothing to read until you attach a feed or sitemap from the row's edit or probe action.
                  </div>
                </div>
              </label>

              {resolveErrors.length > 0 && (
                <details className="text-xs text-[var(--gray-10)]">
                  <summary className="cursor-pointer">Resolver notes ({resolveErrors.length})</summary>
                  <ul className="list-disc pl-5 mt-1 space-y-0.5">
                    {resolveErrors.map((m, i) => <li key={i} className="break-all">{m}</li>)}
                  </ul>
                </details>
              )}
            </fieldset>
          )}
        </form>
      )}

      {step === 2 && (
        <form onSubmit={save} className="space-y-4">
          {!editing && (
            <div className="text-xs text-[var(--gray-11)] break-all">
              Site: <span className="font-mono">{siteUrl}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="discovery-foundation" className={labelClass}>Foundation</label>
              <input
                id="discovery-foundation"
                list={foundationListId}
                className={inputClass}
                placeholder="e.g. CNCF, LF AI & Data, Unassigned"
                value={details.foundation}
                onChange={(e) => update('foundation', e.target.value)}
                autoFocus={!editing}
              />
              <datalist id={foundationListId}>
                {foundations.map((f) => <option key={f} value={f} />)}
              </datalist>
            </div>
            <div>
              <label htmlFor="discovery-project" className={labelClass}>Project</label>
              <input
                id="discovery-project"
                className={inputClass}
                placeholder="Feed label, e.g. Kubernetes blog"
                value={details.project}
                onChange={(e) => update('project', e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="discovery-category" className={labelClass}>Content category <span className="font-normal text-[var(--gray-10)]">(optional)</span></label>
              <input
                id="discovery-category"
                className={inputClass}
                placeholder="Defaults to the module setting (ecosystem)"
                value={details.content_category}
                onChange={(e) => update('content_category', e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="discovery-kind" className={labelClass}>Kind</label>
              <select
                id="discovery-kind"
                className={inputClass}
                value={details.kind}
                onChange={(e) => update('kind', e.target.value as SourceKind)}
              >
                {SOURCE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
          </div>

          {details.kind !== 'html' && (
            <div>
              <label htmlFor="discovery-feed-url" className={labelClass}>
                {details.kind === 'sitemap' ? 'Sitemap URL' : 'Feed URL'}
              </label>
              <input
                id="discovery-feed-url"
                type="url"
                inputMode="url"
                className={inputClass}
                placeholder={details.kind === 'sitemap' ? 'https://example.org/sitemap.xml' : 'https://example.org/blog/index.xml'}
                value={details.feed_url}
                onChange={(e) => update('feed_url', e.target.value)}
              />
            </div>
          )}

          {details.kind === 'sitemap' && (
            <div>
              <label htmlFor="discovery-path-prefix" className={labelClass}>Path prefix</label>
              <input
                id="discovery-path-prefix"
                type="url"
                inputMode="url"
                className={inputClass}
                placeholder="https://example.org/blog/"
                value={details.path_prefix}
                onChange={(e) => update('path_prefix', e.target.value)}
                required
              />
              <p className="mt-1 text-xs text-[var(--gray-10)]">Only sitemap entries under this prefix are treated as posts.</p>
            </div>
          )}

          <div>
            <label htmlFor="discovery-note" className={labelClass}>Note <span className="font-normal text-[var(--gray-10)]">(optional)</span></label>
            <textarea
              id="discovery-note"
              rows={3}
              className={inputClass}
              placeholder="Why this source is here, or anything the next operator should know."
              value={details.note}
              onChange={(e) => update('note', e.target.value)}
            />
          </div>

          {/* Keep Enter-to-submit without a visible second button. */}
          <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
        </form>
      )}
    </Modal>
  );
}

export default AddSourceDrawer;
