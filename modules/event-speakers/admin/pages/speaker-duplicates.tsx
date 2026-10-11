/**
 * Speaker duplicates review queue.
 *
 * The sweep merges only what an account identifier proves. Everything else
 * lands here, because the alternative is a machine guessing: this database
 * holds two different people recorded only as "Ethan" and three recorded only
 * as "Jeff", and it holds one person under six spellings of their own
 * employer. No rule separates those two situations without a human.
 *
 * So each row shows the evidence rather than a verdict, and the operator picks
 * which profile survives.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card } from '@/components/ui';
import {
  getSummary,
  listCandidates,
  mergeCandidate,
  rejectCandidate,
  runLinkedinEnrichment,
  runSweep,
  ruleLabel,
  type DedupeCandidate,
  type DedupeProfile,
  type DedupeSummary,
} from '../utils/dedupeService';

type Tab = 'open' | 'merged' | 'rejected';

function scoreTone(score: number): string {
  if (score >= 0.7) return 'text-amber-600 dark:text-amber-400';
  if (score >= 0.4) return 'text-gray-600 dark:text-gray-400';
  return 'text-gray-400 dark:text-gray-500';
}

function ProfileCard({
  profile,
  isCanonical,
  onKeep,
  disabled,
}: {
  profile: DedupeProfile;
  isCanonical: boolean;
  onKeep: () => void;
  disabled: boolean;
}) {
  const slug = profile.linkedin_url?.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i)?.[1] ?? null;
  return (
    <div
      className={`rounded-lg border p-3 text-sm ${
        isCanonical
          ? 'border-primary-500 bg-primary-50/50 dark:bg-primary-900/10'
          : 'border-gray-200 dark:border-gray-700'
      }`}
    >
      <div className="flex items-start gap-3">
        {profile.avatar_url ? (
          <img src={profile.avatar_url} alt="" className="h-10 w-10 rounded-full object-cover shrink-0" />
        ) : (
          <div className="h-10 w-10 rounded-full bg-gray-200 dark:bg-gray-700 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
              {profile.name ?? '(no name)'}
            </span>
            {isCanonical && <Badge variant="default">Keeping this one</Badge>}
          </div>
          <p className="text-xs text-gray-600 dark:text-gray-400 truncate">
            {[profile.title, profile.company].filter(Boolean).join(', ') || 'No job title or company'}
          </p>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500 dark:text-gray-500">
            {profile.email && <span>{profile.email}</span>}
            {slug && (
              <a
                href={`https://www.linkedin.com/in/${slug}`}
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary-600 dark:text-primary-400 hover:underline"
              >
                /in/{slug}
              </a>
            )}
            {profile.sched_user_id && <span>sched {profile.sched_user_id}</span>}
            {!profile.email && !slug && !profile.sched_user_id && <span>No identifier</span>}
          </div>
        </div>
        {!isCanonical && (
          <Button variant="outline" size="sm" onClick={onKeep} disabled={disabled}>
            Keep this one
          </Button>
        )}
      </div>
    </div>
  );
}

export default function SpeakerDuplicatesPage() {
  const [tab, setTab] = useState<Tab>('open');
  const [summary, setSummary] = useState<DedupeSummary | null>(null);
  const [rows, setRows] = useState<DedupeCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  /** Per-candidate override of which profile survives. */
  const [keep, setKeep] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([getSummary(), listCandidates(tab, 100)]);
      setSummary(s);
      setRows(c);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load the review queue');
      setRows([]);
    }
  }, [tab]);

  useEffect(() => {
    void (async () => { setLoading(true); await load(); setLoading(false); })();
  }, [load]);

  async function act(id: string, what: 'merge' | 'reject') {
    setBusy(id);
    try {
      if (what === 'merge') await mergeCandidate(id, keep[id]);
      else await rejectCandidate(id);
      toast.success(what === 'merge' ? 'Merged' : 'Marked as different people');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  }

  async function kickOff(kind: 'plan' | 'apply' | 'enrich') {
    setBusy(kind);
    try {
      if (kind === 'enrich') {
        await runLinkedinEnrichment(100);
        toast.success('Looking up LinkedIn URLs in the background. Re-run the scan afterwards.');
      } else {
        await runSweep(kind === 'plan');
        toast.success(
          kind === 'plan'
            ? 'Planning in the background. Nothing will be merged; check the worker log for what it would do.'
            : 'Merging in the background. Only groups with a shared account ID are merged automatically.',
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start that');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Duplicate speakers</h1>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        The scan merges a group only when the profiles share an account identifier: a sched account,
        an email address, or a LinkedIn profile. Groups that share only a name come here, because a
        name is not evidence. This database holds two different people recorded only as
        &ldquo;Ethan&rdquo;, and one person under six spellings of their own employer.
      </p>

      <Card className="mt-4 p-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="text-sm text-gray-700 dark:text-gray-300">
            {summary ? (
              <>
                <strong>{summary.candidates.open}</strong> awaiting review ·{' '}
                <strong>{summary.merged_profiles}</strong> profile(s) already merged
              </>
            ) : (
              'Loading…'
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => void kickOff('plan')} disabled={busy !== null}>
              Scan (plan only)
            </Button>
            <Button variant="outline" onClick={() => void kickOff('apply')} disabled={busy !== null}>
              Scan and merge
            </Button>
            <Button variant="outline" onClick={() => void kickOff('enrich')} disabled={busy !== null}
              title="Look up LinkedIn URLs for duplicate-named speakers who have none. Found URLs are marked as a guess and never merged on automatically.">
              Find LinkedIn URLs
            </Button>
          </div>
        </div>
      </Card>

      <div className="mt-4 flex gap-2">
        {(['open', 'merged', 'rejected'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-sm rounded-md ${
              tab === t
                ? 'bg-primary-600 text-white'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
          >
            {t === 'open' ? 'Needs review' : t === 'merged' ? 'Merged' : 'Different people'}
            {summary ? ` (${summary.candidates[t]})` : ''}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="mt-6 text-sm text-gray-500">Loading…</p>
      ) : rows.length === 0 ? (
        <Card className="mt-4 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
          {tab === 'open'
            ? 'Nothing waiting. Run a scan to look for duplicates.'
            : 'Nothing here yet.'}
        </Card>
      ) : (
        <div className="mt-4 space-y-4">
          {rows.map((c) => {
            const canonicalId = keep[c.id] ?? c.canonical_id;
            return (
              <Card key={c.id} className="p-4">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline">{ruleLabel(c.rule)}</Badge>
                      <span className={`text-xs font-medium ${scoreTone(Number(c.score))}`}>
                        {Math.round(Number(c.score) * 100)}% likely the same person
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{c.reason}</p>
                  </div>
                  {c.state === 'open' && (
                    <div className="flex items-center gap-2 shrink-0">
                      <Button onClick={() => void act(c.id, 'merge')} disabled={busy !== null}>
                        Merge {c.profiles.length}
                      </Button>
                      <Button variant="outline" onClick={() => void act(c.id, 'reject')} disabled={busy !== null}>
                        Different people
                      </Button>
                    </div>
                  )}
                </div>

                <div className="mt-3 grid gap-2">
                  {c.profiles.map((p) => (
                    <ProfileCard
                      key={p.id}
                      profile={p}
                      isCanonical={p.id === canonicalId}
                      disabled={busy !== null || c.state !== 'open'}
                      onKeep={() => setKeep((k) => ({ ...k, [c.id]: p.id }))}
                    />
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
