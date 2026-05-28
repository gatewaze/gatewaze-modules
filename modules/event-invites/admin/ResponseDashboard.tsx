import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, Badge, Button, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { ArrowDownTrayIcon, TrashIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';

interface ResponseDashboardProps {
  eventUuid: string;
}

interface QuestionSummary {
  question_id: string;
  question_text: string;
  question_type: string;
  options: string[] | null;
  total_responses: number;
  answer_counts: Record<string, number>;
}

interface DetailRow {
  response_id: string;
  party_name: string;
  member_name: string;
  member_email: string;
  event_title: string;
  rsvp_status: string;
  question_text: string;
  answer: unknown;
}

export function ResponseDashboard({ eventUuid }: ResponseDashboardProps) {
  const [summaries, setSummaries] = useState<QuestionSummary[]>([]);
  const [details, setDetails] = useState<DetailRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'summary' | 'detail'>('summary');
  const [statusFilter, setStatusFilter] = useState<string>('');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // Get questions for this event
      const { data: questions, error: qErr } = await supabase
        .from('invite_questions')
        .select('id, question_text, question_type, options')
        .eq('event_id', eventUuid)
        .order('sort_order');

      if (qErr) throw qErr;
      if (!questions || questions.length === 0) {
        setSummaries([]);
        setDetails([]);
        setLoading(false);
        return;
      }

      // Get all responses for these questions
      const questionIds = questions.map(q => q.id);
      const { data: responses, error: rErr } = await supabase
        .from('invite_responses')
        .select(`
          id,
          answer,
          question_id,
          party_member_event_id,
          invite_party_member_events!inner (
            rsvp_status,
            event_id,
            party_member_id,
            invite_party_members!inner (
              first_name,
              last_name,
              email,
              party_id,
              invite_parties!inner (
                name
              )
            )
          )
        `)
        .in('question_id', questionIds);

      if (rErr) {
        // Fallback: simpler query without deep joins
        const { data: simpleResponses } = await supabase
          .from('invite_responses')
          .select('answer, question_id, party_member_event_id')
          .in('question_id', questionIds);

        // Build summaries from simple data
        const questionSummaries: QuestionSummary[] = questions.map(q => {
          const qResponses = (simpleResponses || []).filter(r => r.question_id === q.id);
          const answerCounts: Record<string, number> = {};

          for (const r of qResponses) {
            const val = typeof r.answer === 'string' ? r.answer : JSON.stringify(r.answer);
            answerCounts[val] = (answerCounts[val] || 0) + 1;
          }

          return {
            question_id: q.id,
            question_text: q.question_text,
            question_type: q.question_type,
            options: q.options,
            total_responses: qResponses.length,
            answer_counts: answerCounts,
          };
        });

        setSummaries(questionSummaries);
        setLoading(false);
        return;
      }

      // Build summaries
      const questionSummaries: QuestionSummary[] = questions.map(q => {
        const qResponses = (responses || []).filter(r => r.question_id === q.id);
        const answerCounts: Record<string, number> = {};

        for (const r of qResponses) {
          const val = typeof r.answer === 'string' ? r.answer : JSON.stringify(r.answer);
          answerCounts[val] = (answerCounts[val] || 0) + 1;
        }

        return {
          question_id: q.id,
          question_text: q.question_text,
          question_type: q.question_type,
          options: q.options,
          total_responses: qResponses.length,
          answer_counts: answerCounts,
        };
      });

      setSummaries(questionSummaries);

      // Build detail rows
      const detailRows: DetailRow[] = (responses || []).map(r => {
        const memberEvent = r.invite_party_member_events as Record<string, unknown>;
        const member = memberEvent?.invite_party_members as Record<string, unknown>;
        const party = member?.invite_parties as Record<string, unknown>;
        const question = questions.find(q => q.id === r.question_id);

        return {
          response_id: r.id,
          party_name: (party?.name as string) || '',
          member_name: [member?.first_name, member?.last_name].filter(Boolean).join(' ') || (member?.email as string) || '',
          member_email: (member?.email as string) || '',
          event_title: '',
          rsvp_status: (memberEvent?.rsvp_status as string) || '',
          question_text: question?.question_text || '',
          answer: r.answer,
        };
      });

      setDetails(detailRows);
    } catch (error) {
      console.error('Error loading responses:', error);
      toast.error('Failed to load responses');
    } finally {
      setLoading(false);
    }
  }, [eventUuid]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const filteredDetails = useMemo(() => {
    if (!statusFilter) return details;
    return details.filter(d => d.rsvp_status === statusFilter);
  }, [details, statusFilter]);

  const exportCsv = () => {
    if (details.length === 0) {
      toast.error('No responses to export');
      return;
    }

    const headers = ['Party', 'Name', 'Email', 'RSVP Status', 'Question', 'Answer'];
    const rows = filteredDetails.map(d => [
      d.party_name,
      d.member_name,
      d.member_email,
      d.rsvp_status,
      d.question_text,
      typeof d.answer === 'string' ? d.answer : JSON.stringify(d.answer),
    ]);

    const csv = [headers, ...rows].map(row =>
      row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
    ).join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `invite-responses-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Responses exported');
  };

  const handleClearAll = async () => {
    if (!confirm('Are you sure you want to delete ALL responses for this event? This cannot be undone.')) return;

    try {
      // Get all question IDs for this event
      const { data: questions } = await supabase
        .from('invite_questions')
        .select('id')
        .eq('event_id', eventUuid);

      if (!questions || questions.length === 0) {
        toast.error('No questions found');
        return;
      }

      const questionIds = questions.map(q => q.id);

      // Delete all responses for these questions
      const { error } = await supabase
        .from('invite_responses')
        .delete()
        .in('question_id', questionIds);

      if (error) throw error;

      toast.success('All responses cleared');
      loadData();
    } catch (error) {
      console.error('Error clearing responses:', error);
      toast.error('Failed to clear responses');
    }
  };

  const handleDeleteResponse = async (responseId: string) => {
    try {
      const { error } = await supabase
        .from('invite_responses')
        .delete()
        .eq('id', responseId);

      if (error) throw error;
      toast.success('Response deleted');
      loadData();
    } catch (error) {
      console.error('Error deleting response:', error);
      toast.error('Failed to delete response');
    }
  };

  if (loading) {
    return <p className="text-sm text-[var(--gray-9)]">Loading responses...</p>;
  }

  if (summaries.length === 0) {
    return (
      <Card className="p-4">
        <p className="text-sm text-[var(--gray-9)] text-center">
          No questions configured for this event. Add questions in the configuration panel above to start collecting responses.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--gray-12)]">Response Summary</h3>
        <div className="flex gap-2">
          <select
            value={viewMode}
            onChange={e => setViewMode(e.target.value as 'summary' | 'detail')}
            className="px-2 py-1 text-xs border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)]"
          >
            <option value="summary">Summary</option>
            <option value="detail">Detail</option>
          </select>
          <Button variant="soft" size="1" onClick={exportCsv}>
            <ArrowDownTrayIcon className="w-3.5 h-3.5 mr-1" />
            Export CSV
          </Button>
          <Button variant="soft" size="1" color="red" onClick={handleClearAll}>
            <TrashIcon className="w-3.5 h-3.5 mr-1" />
            Clear All
          </Button>
        </div>
      </div>

      {viewMode === 'summary' ? (
        <div className="grid gap-3 md:grid-cols-2">
          {summaries.map(s => (
            <Card key={s.question_id} className="p-4">
              <p className="text-sm font-medium text-[var(--gray-12)] mb-2">{s.question_text}</p>
              <p className="text-xs text-[var(--gray-9)] mb-3">{s.total_responses} responses</p>
              {Object.keys(s.answer_counts).length > 0 ? (
                <div className="space-y-1.5">
                  {Object.entries(s.answer_counts)
                    .sort(([, a], [, b]) => b - a)
                    .map(([answer, count]) => {
                      const pct = s.total_responses > 0 ? Math.round((count / s.total_responses) * 100) : 0;
                      return (
                        <div key={answer} className="flex items-center gap-2">
                          <div className="flex-1">
                            <div className="flex justify-between text-xs mb-0.5">
                              <span className="text-[var(--gray-12)]">{answer}</span>
                              <span className="text-[var(--gray-9)]">{count} ({pct}%)</span>
                            </div>
                            <div className="h-1.5 bg-[var(--gray-4)] rounded-full overflow-hidden">
                              <div
                                className="h-full bg-[var(--accent-9)] rounded-full transition-all"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                </div>
              ) : (
                <p className="text-xs text-[var(--gray-9)]">No responses yet</p>
              )}
            </Card>
          ))}
        </div>
      ) : (
        <div>
          <div className="mb-3">
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="px-2 py-1 text-xs border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)]"
            >
              <option value="">All Statuses</option>
              <option value="accepted">Accepted</option>
              <option value="declined">Declined</option>
              <option value="pending">Pending</option>
            </select>
          </div>
          <Table>
            <THead>
              <Tr>
                <Th>Party</Th>
                <Th>Name</Th>
                <Th>RSVP</Th>
                <Th>Question</Th>
                <Th>Answer</Th>
                <Th className="w-10"></Th>
              </Tr>
            </THead>
            <TBody>
              {filteredDetails.length === 0 ? (
                <Tr>
                  <Td colSpan={6} className="text-center py-4 text-[var(--gray-9)] text-sm">
                    No responses found
                  </Td>
                </Tr>
              ) : (
                filteredDetails.map((d, i) => (
                  <Tr key={i}>
                    <Td><span className="text-sm">{d.party_name}</span></Td>
                    <Td>
                      <div>
                        <span className="text-sm font-medium">{d.member_name}</span>
                        {d.member_email && d.member_name !== d.member_email && (
                          <div className="text-xs text-[var(--gray-9)]">{d.member_email}</div>
                        )}
                      </div>
                    </Td>
                    <Td>
                      <Badge color={
                        d.rsvp_status === 'accepted' ? 'green' :
                        d.rsvp_status === 'declined' ? 'red' : 'gray'
                      }>
                        {d.rsvp_status}
                      </Badge>
                    </Td>
                    <Td><span className="text-sm">{d.question_text}</span></Td>
                    <Td>
                      <span className="text-sm">
                        {typeof d.answer === 'string' ? d.answer :
                         Array.isArray(d.answer) ? (d.answer as string[]).join(', ') :
                         JSON.stringify(d.answer)}
                      </span>
                    </Td>
                    <Td>
                      <button
                        onClick={() => handleDeleteResponse(d.response_id)}
                        className="text-[var(--gray-9)] hover:text-red-600 cursor-pointer"
                        title="Delete response"
                      >
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    </Td>
                  </Tr>
                ))
              )}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}
