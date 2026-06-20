import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  PaperAirplaneIcon,
  EnvelopeOpenIcon,
  CursorArrowRaysIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { Card, Badge } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { BlocksOverTime } from './geo/BlocksOverTime';
import { EditionGeographyTab } from './geo/EditionGeographyTab';

interface SendRecord {
  id: string;
  edition_id: string;
  status: string;
  subject: string | null;
  total_recipients: number | null;
  sent_count: number | null;
  failed_count: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  edition_title?: string;
  edition_date?: string;
}

interface EditionRef {
  id: string;
  title: string | null;
  edition_date: string | null;
}

interface Props {
  newsletterId: string;
}

type SubView = 'overview' | 'blocks' | 'geography';

export function NewsletterStatsTab({ newsletterId }: Props) {
  const [sends, setSends] = useState<SendRecord[]>([]);
  const [editions, setEditions] = useState<EditionRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<SubView>('overview');
  const [geoEditionId, setGeoEditionId] = useState<string>('');

  const load = useCallback(async () => {
    try {
      const { data: eds } = await supabase
        .from('newsletters_editions')
        .select('id, title, edition_date')
        .eq('collection_id', newsletterId);

      const editionList: EditionRef[] = (eds ?? []).slice().sort(
        (a, b) => (b.edition_date ?? '').localeCompare(a.edition_date ?? ''),
      );
      setEditions(editionList);
      if (editionList.length) setGeoEditionId((prev) => prev || editionList[0].id);

      if (!eds || eds.length === 0) { setLoading(false); return; }

      const editionIds = eds.map((e) => e.id);
      const editionMap = new Map(eds.map((e) => [e.id, e]));
      const { data: sendsData } = await supabase
        .from('newsletter_sends')
        .select('*')
        .in('edition_id', editionIds)
        .order('created_at', { ascending: false });

      setSends((sendsData ?? []).map((s) => {
        const ed = editionMap.get(s.edition_id);
        return { ...s, edition_title: ed?.title || 'Untitled', edition_date: ed?.edition_date };
      }));
    } catch (err) {
      console.error('Error loading stats:', err);
    } finally {
      setLoading(false);
    }
  }, [newsletterId]);

  useEffect(() => { load(); }, [load]);

  const editionIds = useMemo(() => editions.map((e) => e.id), [editions]);

  if (loading) {
    return <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" /></div>;
  }

  if (editions.length === 0) {
    return (
      <div className="text-center py-16">
        <ChartIcon className="h-16 w-16 text-[var(--gray-8)] mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-[var(--gray-12)] mb-2">No editions yet</h2>
        <p className="text-[var(--gray-11)]">Stats will appear here after you create and send editions.</p>
      </div>
    );
  }

  const subTabs: Array<{ id: SubView; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'blocks', label: 'Blocks' },
    { id: 'geography', label: 'Geography' },
  ];

  return (
    <div className="space-y-6">
      {/* sub-navigation */}
      <div className="flex gap-1 border-b border-[var(--gray-a4)]">
        {subTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setView(t.id)}
            aria-current={view === t.id ? 'page' : undefined}
            className={
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px ' +
              (view === t.id
                ? 'border-[var(--accent-9)] text-[var(--gray-12)]'
                : 'border-transparent text-[var(--gray-10)] hover:text-[var(--gray-12)]')
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {view === 'overview' && <OverviewView sends={sends} />}

      {view === 'blocks' && <BlocksOverTime editionIds={editionIds} />}

      {view === 'geography' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <label htmlFor="geo-edition" className="text-sm text-[var(--gray-11)]">Edition</label>
            <select
              id="geo-edition"
              className="rounded-md border border-[var(--gray-a5)] bg-[var(--color-surface)] px-2 py-1 text-sm"
              value={geoEditionId}
              onChange={(e) => setGeoEditionId(e.target.value)}
            >
              {editions.map((ed) => (
                <option key={ed.id} value={ed.id}>
                  {(ed.edition_date ? new Date(ed.edition_date).toLocaleDateString() + ' — ' : '') + (ed.title || 'Untitled')}
                </option>
              ))}
            </select>
          </div>
          {geoEditionId && <EditionGeographyTab editionId={geoEditionId} />}
        </div>
      )}
    </div>
  );
}

function OverviewView({ sends }: { sends: SendRecord[] }) {
  if (sends.length === 0) {
    return (
      <div className="text-center py-12">
        <ChartIcon className="h-12 w-12 text-[var(--gray-8)] mx-auto mb-3" />
        <p className="text-[var(--gray-11)]">No sends yet. Summary will appear after your first send.</p>
      </div>
    );
  }
  const completedSends = sends.filter((s) => s.status === 'sent');
  const totalSent = completedSends.reduce((sum, s) => sum + (s.sent_count || 0), 0);
  const totalRecipients = completedSends.reduce((sum, s) => sum + (s.total_recipients || 0), 0);
  const totalFailed = completedSends.reduce((sum, s) => sum + (s.failed_count || 0), 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={PaperAirplaneIcon} label="Total Sends" value={completedSends.length} />
        <StatCard icon={EnvelopeOpenIcon} label="Emails Sent" value={totalSent} />
        <StatCard icon={ExclamationTriangleIcon} label="Failed" value={totalFailed} color={totalFailed > 0 ? 'red' : undefined} />
        <StatCard icon={CursorArrowRaysIcon} label="Recipients" value={totalRecipients} />
      </div>

      <Card variant="surface" className="p-6">
        <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-4">Send History</h2>
        <div className="space-y-3">
          {sends.map((send) => (
            <div key={send.id} className="flex items-center justify-between py-3 border-b border-[var(--gray-a4)] last:border-0">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--gray-12)]">
                    {send.edition_title || send.subject || 'Untitled'}
                  </span>
                  <Badge variant="soft" color={send.status === 'sent' ? 'green' : send.status === 'failed' ? 'red' : send.status === 'sending' ? 'blue' : 'gray'} size="1">
                    {send.status}
                  </Badge>
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-[var(--gray-9)]">
                  {send.edition_date && <span>{new Date(send.edition_date).toLocaleDateString()}</span>}
                  {send.sent_count != null && <span>{send.sent_count} sent</span>}
                  {send.failed_count != null && send.failed_count > 0 && (
                    <span className="text-red-500">{send.failed_count} failed</span>
                  )}
                  {send.total_recipients != null && <span>{send.total_recipients} recipients</span>}
                </div>
              </div>
              <div className="text-xs text-[var(--gray-9)]">
                {send.completed_at ? new Date(send.completed_at).toLocaleString() : send.created_at ? new Date(send.created_at).toLocaleString() : ''}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: number; color?: string }) {
  return (
    <Card variant="surface" className="p-4 text-center">
      <Icon className={`h-6 w-6 mx-auto mb-2 ${color === 'red' ? 'text-red-500' : 'text-[var(--accent-9)]'}`} />
      <p className={`text-2xl font-bold ${color === 'red' ? 'text-red-600' : 'text-[var(--gray-12)]'}`}>{value.toLocaleString()}</p>
      <p className="text-xs text-[var(--gray-9)] mt-1">{label}</p>
    </Card>
  );
}

function ChartIcon(props: { className?: string }) {
  return (
    <svg {...props} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
    </svg>
  );
}
