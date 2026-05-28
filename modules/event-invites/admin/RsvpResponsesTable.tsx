import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, Badge, Button, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { ArrowDownTrayIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';

interface RsvpResponsesTableProps {
  eventUuid: string;
}

interface Row {
  member_event_id: string;
  party_id: string;
  party_name: string;
  member_id: string;
  member_first_name: string;
  member_last_name: string;
  member_email: string;
  member_phone: string;
  is_lead_booker: boolean;
  is_plus_one: boolean;
  sort_order: number;
  sub_event_name: string;
  sub_event_sort_order: number;
  rsvp_status: string;
  responded_at: string | null;
  answers: Record<string, string>; // question_text → stringified answer
}

type StatusFilter = '' | 'accepted' | 'declined' | 'pending' | 'maybe';

function memberDisplayName(r: Row): string {
  const parts = [r.member_first_name, r.member_last_name].map(s => (s || '').trim()).filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return r.member_email || '(unnamed)';
}

function formatRespondedAt(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function answerToString(answer: unknown): string {
  if (answer == null) return '';
  if (typeof answer === 'string') return answer;
  if (Array.isArray(answer)) return (answer as unknown[]).map(a => String(a)).join(', ');
  if (typeof answer === 'boolean') return answer ? 'Yes' : 'No';
  return JSON.stringify(answer);
}

export function RsvpResponsesTable({ eventUuid }: RsvpResponsesTableProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [questionTexts, setQuestionTexts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const [search, setSearch] = useState('');
  const [subEventFilter, setSubEventFilter] = useState<string>('');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // 1. All member_events for this event
      const { data: memberEvents, error: meErr } = await supabase
        .from('invite_party_member_events')
        .select('id, party_member_id, sub_event_id, rsvp_status, rsvp_responded_at')
        .eq('event_id', eventUuid);
      if (meErr) throw meErr;

      if (!memberEvents || memberEvents.length === 0) {
        setRows([]);
        setQuestionTexts([]);
        setLoading(false);
        return;
      }

      // 2. Related members
      const memberIds = Array.from(new Set(memberEvents.map(me => me.party_member_id).filter(Boolean))) as string[];
      const { data: members } = memberIds.length > 0
        ? await supabase
            .from('invite_party_members')
            .select('id, party_id, first_name, last_name, email, phone, is_lead_booker, is_plus_one, sort_order')
            .in('id', memberIds)
        : { data: [] };
      const memberMap = new Map<string, typeof members[0]>();
      for (const m of members || []) memberMap.set(m.id, m);

      // 3. Related parties
      const partyIds = Array.from(new Set((members || []).map(m => m.party_id).filter(Boolean))) as string[];
      const { data: parties } = partyIds.length > 0
        ? await supabase
            .from('invite_parties')
            .select('id, name')
            .in('id', partyIds)
        : { data: [] };
      const partyMap = new Map<string, string>();
      for (const p of parties || []) partyMap.set(p.id, p.name || '');

      // 4. Sub-events (all for this event — small set)
      const { data: subEvents } = await supabase
        .from('invite_sub_events')
        .select('id, name, sort_order')
        .eq('event_id', eventUuid);
      const subEventMap = new Map<string, { name: string; sort_order: number }>();
      for (const se of subEvents || []) subEventMap.set(se.id, { name: se.name || '', sort_order: se.sort_order ?? 0 });

      // 5. Questions for this event
      const { data: questions } = await supabase
        .from('invite_questions')
        .select('id, question_text, sort_order')
        .eq('event_id', eventUuid)
        .order('sort_order');
      const questionTextById = new Map<string, string>();
      const questionOrder: string[] = [];
      for (const q of questions || []) {
        questionTextById.set(q.id, q.question_text);
        questionOrder.push(q.question_text);
      }

      // 6. Answers for all these member_events
      // Batched because the list can be large on busy events.
      const memberEventIds = memberEvents.map(me => me.id);
      const answers: Array<{ party_member_event_id: string; question_id: string; answer: unknown }> = [];
      if (memberEventIds.length > 0 && (questions || []).length > 0) {
        const BATCH = 100;
        for (let i = 0; i < memberEventIds.length; i += BATCH) {
          const slice = memberEventIds.slice(i, i + BATCH);
          const { data: ansBatch } = await supabase
            .from('invite_responses')
            .select('party_member_event_id, question_id, answer')
            .in('party_member_event_id', slice);
          if (ansBatch) answers.push(...ansBatch);
        }
      }
      const answersByMemberEvent = new Map<string, Record<string, string>>();
      for (const a of answers) {
        const qText = questionTextById.get(a.question_id);
        if (!qText) continue;
        const bucket = answersByMemberEvent.get(a.party_member_event_id) || {};
        bucket[qText] = answerToString(a.answer);
        answersByMemberEvent.set(a.party_member_event_id, bucket);
      }

      // 7. Compose rows
      const composed: Row[] = [];
      for (const me of memberEvents) {
        const member = memberMap.get(me.party_member_id);
        if (!member) continue;
        const partyName = partyMap.get(member.party_id || '') || '';
        const sub = me.sub_event_id ? subEventMap.get(me.sub_event_id) : undefined;
        composed.push({
          member_event_id: me.id,
          party_id: member.party_id || '',
          party_name: partyName,
          member_id: member.id,
          member_first_name: member.first_name || '',
          member_last_name: member.last_name || '',
          member_email: member.email || '',
          member_phone: member.phone || '',
          is_lead_booker: !!member.is_lead_booker,
          is_plus_one: !!member.is_plus_one,
          sort_order: member.sort_order ?? 0,
          sub_event_name: sub?.name || '(no sub-event)',
          sub_event_sort_order: sub?.sort_order ?? 999,
          rsvp_status: me.rsvp_status || 'pending',
          responded_at: me.rsvp_responded_at,
          answers: answersByMemberEvent.get(me.id) || {},
        });
      }

      composed.sort((a, b) => {
        if (a.party_name !== b.party_name) return a.party_name.localeCompare(b.party_name);
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        return a.sub_event_sort_order - b.sub_event_sort_order;
      });

      setRows(composed);
      setQuestionTexts(questionOrder);
    } catch (err) {
      console.error('Error loading RSVP responses:', err);
      toast.error('Failed to load RSVP responses');
    } finally {
      setLoading(false);
    }
  }, [eventUuid]);

  useEffect(() => { loadData(); }, [loadData]);

  const distinctSubEvents = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of rows) {
      if (!seen.has(r.sub_event_name)) seen.set(r.sub_event_name, r.sub_event_sort_order);
    }
    return Array.from(seen.entries()).sort((a, b) => a[1] - b[1]).map(([name]) => name);
  }, [rows]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter(r => {
      if (statusFilter && r.rsvp_status !== statusFilter) return false;
      if (subEventFilter && r.sub_event_name !== subEventFilter) return false;
      if (!term) return true;
      const hay = [r.party_name, r.member_first_name, r.member_last_name, r.member_email, r.member_phone]
        .map(s => (s || '').toLowerCase())
        .join(' ');
      return hay.includes(term);
    });
  }, [rows, statusFilter, subEventFilter, search]);

  const counts = useMemo(() => {
    const out = { total: rows.length, accepted: 0, declined: 0, pending: 0, maybe: 0 };
    for (const r of rows) {
      if (r.rsvp_status === 'accepted') out.accepted++;
      else if (r.rsvp_status === 'declined') out.declined++;
      else if (r.rsvp_status === 'maybe') out.maybe++;
      else out.pending++;
    }
    return out;
  }, [rows]);

  const csvEscape = (v: string | number | boolean): string => {
    const s = String(v ?? '');
    // RFC 4180 quoting
    if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const exportCsv = () => {
    if (filtered.length === 0) {
      toast.error('No rows to export with the current filters');
      return;
    }
    const headers = [
      'Party',
      'First Name',
      'Last Name',
      'Email',
      'Phone',
      'Lead Booker',
      'Plus One',
      'Sub-Event',
      'RSVP Status',
      'Responded At',
      ...questionTexts,
    ];
    const lines: string[] = [headers.map(csvEscape).join(',')];
    for (const r of filtered) {
      const row: (string | number | boolean)[] = [
        r.party_name,
        r.member_first_name,
        r.member_last_name,
        r.member_email,
        r.member_phone,
        r.is_lead_booker ? 'yes' : '',
        r.is_plus_one ? 'yes' : '',
        r.sub_event_name,
        r.rsvp_status,
        formatRespondedAt(r.responded_at),
        ...questionTexts.map(q => r.answers[q] || ''),
      ];
      lines.push(row.map(csvEscape).join(','));
    }
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rsvp-responses-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${filtered.length} row${filtered.length === 1 ? '' : 's'}`);
  };

  if (loading) {
    return <p className="text-sm text-[var(--gray-9)]">Loading RSVP responses...</p>;
  }

  if (rows.length === 0) {
    return (
      <Card className="p-4">
        <p className="text-sm text-[var(--gray-9)] text-center">No invite members assigned to this event yet.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-[var(--gray-12)]">RSVPs by person</h3>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-[var(--gray-11)]">{counts.total} total</span>
          <span className="text-[var(--green-11)]">{counts.accepted} accepted</span>
          <span className="text-[var(--red-11)]">{counts.declined} declined</span>
          {counts.maybe > 0 && <span className="text-[var(--gray-11)]">{counts.maybe} maybe</span>}
          <span className="text-[var(--gray-11)]">{counts.pending} pending</span>
          <Button variant="soft" size="1" onClick={exportCsv}>
            <ArrowDownTrayIcon className="w-3.5 h-3.5 mr-1" />
            Export CSV
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--gray-9)]" />
          <input
            type="text"
            placeholder="Search name, email, party..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
          />
        </div>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as StatusFilter)}
          className="px-2 py-1.5 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
        >
          <option value="">All statuses</option>
          <option value="accepted">Accepted</option>
          <option value="declined">Declined</option>
          <option value="pending">Pending</option>
          <option value="maybe">Maybe</option>
        </select>
        {distinctSubEvents.length > 1 && (
          <select
            value={subEventFilter}
            onChange={e => setSubEventFilter(e.target.value)}
            className="px-2 py-1.5 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
          >
            <option value="">All sub-events</option>
            {distinctSubEvents.map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        )}
      </div>

      <div className="overflow-x-auto">
        <Table>
          <THead>
            <Tr>
              <Th>Party</Th>
              <Th>Name</Th>
              <Th>Sub-Event</Th>
              <Th>Status</Th>
              <Th>Responded</Th>
              {questionTexts.map(q => <Th key={q}>{q}</Th>)}
            </Tr>
          </THead>
          <TBody>
            {filtered.length === 0 ? (
              <Tr>
                <Td colSpan={5 + questionTexts.length} className="text-center py-4 text-[var(--gray-9)] text-sm">
                  No rows match the current filters
                </Td>
              </Tr>
            ) : (
              filtered.map(r => (
                <Tr key={r.member_event_id}>
                  <Td><span className="text-sm">{r.party_name}</span></Td>
                  <Td>
                    <div>
                      <div className="text-sm font-medium flex items-center gap-1.5">
                        {memberDisplayName(r)}
                        {r.is_lead_booker && <Badge color="blue">Lead</Badge>}
                        {r.is_plus_one && <Badge color="gray">Guest</Badge>}
                      </div>
                      {r.member_email && (
                        <div className="text-xs text-[var(--gray-9)]">{r.member_email}</div>
                      )}
                    </div>
                  </Td>
                  <Td><span className="text-sm">{r.sub_event_name}</span></Td>
                  <Td>
                    <Badge color={
                      r.rsvp_status === 'accepted' ? 'green' :
                      r.rsvp_status === 'declined' ? 'red' :
                      r.rsvp_status === 'maybe' ? 'yellow' : 'gray'
                    }>
                      {r.rsvp_status}
                    </Badge>
                  </Td>
                  <Td><span className="text-xs text-[var(--gray-9)]">{formatRespondedAt(r.responded_at)}</span></Td>
                  {questionTexts.map(q => (
                    <Td key={q}><span className="text-sm">{r.answers[q] || ''}</span></Td>
                  ))}
                </Tr>
              ))
            )}
          </TBody>
        </Table>
      </div>
    </div>
  );
}
