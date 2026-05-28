import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, Badge, Button, Table, THead, TBody, Tr, Th, Td, Modal } from '@/components/ui';
import { ClipboardDocumentIcon, XCircleIcon, ArrowPathIcon, ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  AdminResponseModal,
  type AdminResponseQuestion,
  type AdminResponseMemberEvent,
} from './AdminResponseModal';

interface InviteParty {
  id: string;
  name: string;
  short_code: string;
  token: string;
  status: string;
  delivery_channel: string;
  max_plus_ones: number;
  plus_ones_added: number;
  sent_at: string | null;
  opened_at: string | null;
  responded_at: string | null;
  notes: string | null;
  version: number;
  created_at: string;
  member_count: number;
  accepted_count: number;
  declined_count: number;
  pending_count: number;
  lead_first_name: string | null;
  lead_last_name: string | null;
  lead_email: string | null;
}

interface PartyDetailModalProps {
  party: InviteParty | null;
  onClose: () => void;
  onUpdate: () => void;
  /** Base URL for RSVP links. Parent resolves custom-domain + portal
   *  env once and passes it through so this modal doesn't need to know
   *  about custom domains itself. Omit to fall back to the generic
   *  env/window-origin chain. */
  portalUrl?: string;
}

interface PartyMemberRow {
  member_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  is_lead: boolean;
  is_plus_one: boolean;
  event_id: string;
  event_title: string;
  sub_event_id: string | null;
  sub_event_name: string | null;
  rsvp_status: string;
  member_event_id: string;
  sort_order: number;
}

interface InviteResponse {
  member_event_id: string;
  question_id: string;
  question_text: string;
  answer: unknown;
}

interface GroupedMember {
  member_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  is_lead: boolean;
  is_plus_one: boolean;
  events: {
    event_id: string;
    event_title: string;
    sub_event_id: string | null;
    sub_event_name: string | null;
    rsvp_status: string;
    member_event_id: string;
  }[];
}

const formatDate = (dateStr: string | null) => {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

const fallbackPortalUrl = import.meta.env.VITE_PORTAL_URL || import.meta.env.VITE_APP_URL || window.location.origin;

export function PartyDetailModal({ party, onClose, onUpdate, portalUrl: portalUrlProp }: PartyDetailModalProps) {
  const portalUrl = portalUrlProp || fallbackPortalUrl;
  const [members, setMembers] = useState<PartyMemberRow[]>([]);
  const [responses, setResponses] = useState<InviteResponse[]>([]);
  const [questions, setQuestions] = useState<AdminResponseQuestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [savingMemberEventId, setSavingMemberEventId] = useState<string | null>(null);
  const [responderMemberId, setResponderMemberId] = useState<string | null>(null);

  const rsvpLink = party ? `${portalUrl}/rsvp/${party.short_code}` : '';

  const fetchData = useCallback(async () => {
    if (!party) return;
    setLoading(true);
    try {
      const { data: memberData, error: memberError } = await supabase
        .from('invite_party_detail')
        .select('*')
        .eq('party_id', party.id)
        .order('sort_order');

      if (memberError) throw memberError;
      const rows = (memberData as PartyMemberRow[]) || [];
      setMembers(rows);

      // Load questions for the event so we can (a) show existing responses
      // and (b) let the admin manually answer on behalf of a member.
      const eventIds = Array.from(new Set(rows.map(r => r.event_id))).filter(Boolean);
      if (eventIds.length > 0) {
        const { data: questionData, error: questionError } = await supabase
          .from('invite_questions')
          .select('id, event_id, sub_event_id, question_text, question_type, options, is_required, applies_to, sort_order')
          .in('event_id', eventIds)
          .order('sort_order');
        if (questionError) throw questionError;
        setQuestions((questionData as AdminResponseQuestion[]) || []);
      } else {
        setQuestions([]);
      }

      // Load responses for every member-event (not just accepted — admins may
      // want to see historical answers even if RSVP was later changed).
      const memberEventIds = rows.map(r => r.member_event_id);
      if (memberEventIds.length > 0) {
        const { data: responseData, error: responseError } = await supabase
          .from('invite_responses')
          .select('party_member_event_id, question_id, answer, invite_questions(question_text)')
          .in('party_member_event_id', memberEventIds);

        if (responseError) throw responseError;
        setResponses(
          (responseData || []).map((r: any) => ({
            member_event_id: r.party_member_event_id,
            question_id: r.question_id,
            question_text: r.invite_questions?.question_text ?? '',
            answer: r.answer,
          })),
        );
      } else {
        setResponses([]);
      }
    } catch (err: any) {
      toast.error(`Failed to load party details: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [party]);

  useEffect(() => {
    if (party) fetchData();
  }, [party, fetchData]);

  const groupedMembers = useMemo<GroupedMember[]>(() => {
    const map = new Map<string, GroupedMember>();
    for (const row of members) {
      let member = map.get(row.member_id);
      if (!member) {
        member = {
          member_id: row.member_id,
          first_name: row.first_name,
          last_name: row.last_name,
          email: row.email,
          is_lead: row.is_lead,
          is_plus_one: row.is_plus_one,
          events: [],
        };
        map.set(row.member_id, member);
      }
      member.events.push({
        event_id: row.event_id,
        event_title: row.sub_event_name || row.event_title,
        sub_event_id: row.sub_event_id,
        sub_event_name: row.sub_event_name,
        rsvp_status: row.rsvp_status,
        member_event_id: row.member_event_id,
      });
    }
    return Array.from(map.values());
  }, [members]);

  const eventTitles = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of members) {
      const key = row.sub_event_id || row.event_id;
      if (!seen.has(key)) seen.set(key, row.sub_event_name || row.event_title);
    }
    return Array.from(seen.entries());
  }, [members]);

  const copyToClipboard = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} copied to clipboard`),
      () => toast.error('Failed to copy to clipboard'),
    );
  }, []);

  const handleCancel = useCallback(async () => {
    if (!party) return;
    setActionLoading(true);
    try {
      const { error } = await supabase
        .from('invite_parties')
        .update({ status: 'cancelled' })
        .eq('id', party.id);
      if (error) throw error;
      toast.success('Party cancelled');
      onUpdate();
      onClose();
    } catch (err: any) {
      toast.error(`Failed to cancel party: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  }, [party, onUpdate, onClose]);

  const handleAdminRsvp = useCallback(
    async (memberEventId: string, newStatus: string) => {
      setSavingMemberEventId(memberEventId);
      try {
        const { error } = await supabase
          .from('invite_party_member_events')
          .update({
            rsvp_status: newStatus,
            responded_at: newStatus === 'pending' ? null : new Date().toISOString(),
          })
          .eq('id', memberEventId);
        if (error) throw error;
        setMembers((prev) =>
          prev.map((m) =>
            m.member_event_id === memberEventId ? { ...m, rsvp_status: newStatus } : m,
          ),
        );
        toast.success('RSVP updated');
        onUpdate();
      } catch (err: any) {
        toast.error(`Failed to update RSVP: ${err.message}`);
      } finally {
        setSavingMemberEventId(null);
      }
    },
    [onUpdate],
  );

  const handleResend = useCallback(async () => {
    if (!party) return;
    setActionLoading(true);
    try {
      const { error } = await supabase.functions.invoke('send-invite', {
        body: { party_id: party.id },
      });
      if (error) throw error;
      toast.success('Invite resent');
      onUpdate();
    } catch (err: any) {
      toast.error(`Failed to resend invite: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  }, [party, onUpdate]);

  if (!party) return null;

  const modalFooter = (
    <div className="flex items-center gap-3">
      <Button variant="secondary" onClick={() => copyToClipboard(rsvpLink, 'RSVP link')}>
        <ClipboardDocumentIcon className="h-4 w-4 mr-1" />
        Copy RSVP Link
      </Button>
      {(party.status === 'sent' || party.status === 'send_failed') && (
        <Button variant="secondary" onClick={handleResend} disabled={actionLoading}>
          <ArrowPathIcon className="h-4 w-4 mr-1" />
          Resend
        </Button>
      )}
      {party.status !== 'cancelled' && (
        <Button variant="danger" onClick={handleCancel} disabled={actionLoading}>
          <XCircleIcon className="h-4 w-4 mr-1" />
          Cancel Party
        </Button>
      )}
    </div>
  );

  return (
    <Modal isOpen={!!party} onClose={onClose} title="Party Details" size="xl" footer={modalFooter}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">{party.name}</h2>
            <div className="mt-1 flex items-center gap-2">
              <Badge color={party.status === 'cancelled' ? 'red' : party.status === 'sent' ? 'blue' : 'gray'}>
                {party.status}
              </Badge>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
                onClick={() => copyToClipboard(party.short_code, 'Short code')}
              >
                <span className="font-mono">{party.short_code}</span>
                <ClipboardDocumentIcon className="h-4 w-4" />
              </button>
            </div>
            <button
              type="button"
              className="mt-1 inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
              onClick={() => copyToClipboard(rsvpLink, 'RSVP link')}
            >
              <span className="truncate max-w-xs">{rsvpLink}</span>
              <ClipboardDocumentIcon className="h-4 w-4 flex-shrink-0" />
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-4">
          <Card className="p-3 text-center">
            <div className="text-2xl font-bold">{party.member_count}</div>
            <div className="text-sm text-gray-500">Members</div>
          </Card>
          <Card className="p-3 text-center">
            <div className="text-2xl font-bold text-green-600">{party.accepted_count}</div>
            <div className="text-sm text-gray-500">Accepted</div>
          </Card>
          <Card className="p-3 text-center">
            <div className="text-2xl font-bold text-red-600">{party.declined_count}</div>
            <div className="text-sm text-gray-500">Declined</div>
          </Card>
          <Card className="p-3 text-center">
            <div className="text-2xl font-bold text-gray-500">{party.pending_count}</div>
            <div className="text-sm text-gray-500">Pending</div>
          </Card>
        </div>

        {/* Members table */}
        <div>
          <h3 className="text-lg font-medium mb-2">Members</h3>
          {loading ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : (
            <Table>
              <THead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  {eventTitles.map(([eventId, title]) => (
                    <Th key={eventId}>{title}</Th>
                  ))}
                  <Th style={{ width: 110 }}>Answers</Th>
                </Tr>
              </THead>
              <TBody>
                {groupedMembers.map((member) => {
                  const hasAccepted = member.events.some((e) => e.rsvp_status === 'accepted');
                  const applicableQuestionCount = hasAccepted
                    ? member.events
                        .filter((e) => e.rsvp_status === 'accepted')
                        .reduce((sum, e) => {
                          return sum + questions.filter(
                            (q) => q.sub_event_id === e.sub_event_id || q.sub_event_id === null,
                          ).length;
                        }, 0)
                    : 0;
                  const answeredCount = responses.filter((r) =>
                    member.events.some((e) => e.member_event_id === r.member_event_id),
                  ).length;
                  return (
                    <Tr key={member.member_id}>
                      <Td>{[member.first_name, member.last_name].filter(Boolean).join(' ') || '—'}</Td>
                      <Td>{member.email || '—'}</Td>
                      <Td className="space-x-1">
                        {member.is_lead && <Badge color="blue">Lead</Badge>}
                        {member.is_plus_one && <Badge color="purple">Plus One</Badge>}
                      </Td>
                      {eventTitles.map(([eventId]) => {
                        const ev = member.events.find((e) => e.event_id === eventId);
                        return (
                          <Td key={eventId}>
                            {ev ? (
                              <select
                                value={ev.rsvp_status}
                                onChange={(e) => handleAdminRsvp(ev.member_event_id, e.target.value)}
                                disabled={savingMemberEventId === ev.member_event_id}
                                className={`text-xs px-2 py-1 rounded border border-[var(--gray-6)] bg-[var(--color-background)] cursor-pointer focus:outline-none focus:ring-1 focus:ring-[var(--accent-7)] ${
                                  ev.rsvp_status === 'accepted'
                                    ? 'text-[var(--green-11)]'
                                    : ev.rsvp_status === 'declined'
                                    ? 'text-[var(--red-11)]'
                                    : 'text-[var(--gray-11)]'
                                }`}
                              >
                                <option value="pending">Pending</option>
                                <option value="accepted">Accepted</option>
                                <option value="declined">Declined</option>
                              </select>
                            ) : (
                              '—'
                            )}
                          </Td>
                        );
                      })}
                      <Td>
                        {hasAccepted && applicableQuestionCount > 0 ? (
                          <button
                            type="button"
                            onClick={() => setResponderMemberId(member.member_id)}
                            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-[var(--gray-6)] hover:bg-[var(--gray-3)] cursor-pointer"
                            title="Respond on behalf of this member"
                          >
                            <ChatBubbleLeftRightIcon className="w-3.5 h-3.5" />
                            {answeredCount > 0 ? `${answeredCount}/${applicableQuestionCount}` : 'Answer'}
                          </button>
                        ) : (
                          <span className="text-xs text-[var(--gray-9)]">—</span>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
                {groupedMembers.length === 0 && (
                  <Tr>
                    <Td colSpan={4 + eventTitles.length} className="text-center text-gray-500">
                      No members found
                    </Td>
                  </Tr>
                )}
              </TBody>
            </Table>
          )}
        </div>

        {/* Responses */}
        {responses.length > 0 && (
          <div>
            <h3 className="text-lg font-medium mb-2">Responses</h3>
            <div className="space-y-3">
              {groupedMembers.map((member) => {
                const memberEventIds = member.events.map((e) => e.member_event_id);
                const memberResponses = responses.filter((r) =>
                  memberEventIds.includes(r.member_event_id),
                );
                if (memberResponses.length === 0) return null;
                return (
                  <Card key={member.member_id} className="p-3">
                    <p className="font-medium mb-1">
                      {[member.first_name, member.last_name].filter(Boolean).join(' ')}
                    </p>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                      {memberResponses.map((r, i) => (
                        <div key={i} className="contents">
                          <dt className="text-gray-500">{r.question_text}</dt>
                          <dd>{Array.isArray(r.answer) ? (r.answer as string[]).join(', ') : String(r.answer ?? '')}</dd>
                        </div>
                      ))}
                    </dl>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        {/* Timeline */}
        <div>
          <h3 className="text-lg font-medium mb-2">Timeline</h3>
          <ul className="space-y-1 text-sm">
            <li><span className="text-gray-500">Created:</span> {formatDate(party.created_at)}</li>
            {party.sent_at && (
              <li><span className="text-gray-500">Sent:</span> {formatDate(party.sent_at)}</li>
            )}
            {party.opened_at && (
              <li><span className="text-gray-500">Opened:</span> {formatDate(party.opened_at)}</li>
            )}
            {party.responded_at && (
              <li><span className="text-gray-500">Responded:</span> {formatDate(party.responded_at)}</li>
            )}
          </ul>
        </div>

        {/* Delivery History */}
        <DeliveryHistory partyId={party.id} />
      </div>

      {/* Admin response editor */}
      {(() => {
        const responder = responderMemberId
          ? groupedMembers.find(m => m.member_id === responderMemberId)
          : null;
        if (!responder) return null;
        const memberEvents: AdminResponseMemberEvent[] = responder.events.map(e => ({
          member_event_id: e.member_event_id,
          event_id: e.event_id,
          sub_event_id: e.sub_event_id,
          sub_event_name: e.sub_event_name,
          rsvp_status: e.rsvp_status,
        }));
        const memberName = [responder.first_name, responder.last_name].filter(Boolean).join(' ') || responder.email || 'Member';
        const existing = new Map<string, unknown>();
        for (const r of responses) {
          if (memberEvents.some(me => me.member_event_id === r.member_event_id)) {
            existing.set(`${r.member_event_id}:${r.question_id}`, r.answer);
          }
        }
        return (
          <AdminResponseModal
            isOpen={!!responderMemberId}
            onClose={() => setResponderMemberId(null)}
            memberName={memberName}
            memberEvents={memberEvents}
            questions={questions}
            existingAnswers={existing}
            onSaved={() => {
              fetchData();
              onUpdate();
            }}
          />
        );
      })()}
    </Modal>
  );
}

// --- Delivery History Sub-Component ---

function DeliveryHistory({ partyId }: { partyId: string }) {
  const [deliveries, setDeliveries] = useState<Array<{
    id: string; channel: string; status: string; sent_at: string | null; created_at: string; error_message: string | null;
  }>>([]);

  useEffect(() => {
    supabase
      .from('invite_deliveries')
      .select('id, channel, status, sent_at, created_at, error_message')
      .eq('party_id', partyId)
      .order('created_at', { ascending: false })
      .then(({ data }) => setDeliveries(data || []));
  }, [partyId]);

  if (deliveries.length === 0) return null;

  const channelLabel: Record<string, string> = { pdf: 'PDF', email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };
  const statusColor: Record<string, 'green' | 'blue' | 'red' | 'yellow' | 'gray'> = {
    sent: 'blue', delivered: 'green', downloaded: 'green', failed: 'red', pending: 'yellow',
  };

  return (
    <div>
      <h3 className="text-lg font-medium mb-2">Delivery History</h3>
      <div className="space-y-1">
        {deliveries.map(d => (
          <div key={d.id} className="flex items-center gap-3 text-sm py-1">
            <Badge color="gray">{channelLabel[d.channel] || d.channel}</Badge>
            <Badge color={statusColor[d.status] || 'gray'}>{d.status}</Badge>
            <span className="text-gray-500 text-xs">{formatDate(d.sent_at || d.created_at)}</span>
            {d.error_message && <span className="text-red-500 text-xs">{d.error_message}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
