import React, { useState, useEffect, useCallback, Suspense } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, Badge, Button, Table, THead, TBody, Tr, Th, Td, ConfirmModal } from '@/components/ui';
import { ScrollableTable } from '@/components/shared/table/ScrollableTable';
import { RowActions } from '@/components/shared/table/RowActions';
import {
  EnvelopeIcon,
  PlusIcon,
  ArrowUpTrayIcon,
  PaperAirplaneIcon,
  UserGroupIcon,
  ClipboardDocumentIcon,
  EyeIcon,
  TrashIcon,
  MagnifyingGlassIcon,
  Cog6ToothIcon,
  DocumentTextIcon,
  InboxIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { CreatePartyModal } from './CreatePartyModal';
import { PartyDetailModal } from './PartyDetailModal';

// Lazy-loaded components to avoid Vite chunk splitting issues with React hooks
const QuestionConfigPanel = React.lazy(() => import('./QuestionConfigPanel').then(m => ({ default: m.QuestionConfigPanel })));
const ResponseDashboard = React.lazy(() => import('./ResponseDashboard').then(m => ({ default: m.ResponseDashboard })));
const RsvpResponsesTable = React.lazy(() => import('./RsvpResponsesTable').then(m => ({ default: m.RsvpResponsesTable })));
const ReminderConfigPanel = React.lazy(() => import('./ReminderConfigPanel').then(m => ({ default: m.ReminderConfigPanel })));
const QrCodeExport = React.lazy(() => import('./QrCodeExport').then(m => ({ default: m.QrCodeExport })));
const InvitePdfGenerator = React.lazy(() => import('./InvitePdfGenerator').then(m => ({ default: m.InvitePdfGenerator })));
const EnvelopePdfGenerator = React.lazy(() => import('./EnvelopePdfGenerator').then(m => ({ default: m.EnvelopePdfGenerator })));
const SubEventConfigPanel = React.lazy(() => import('./SubEventConfigPanel').then(m => ({ default: m.SubEventConfigPanel })));
const InviteTemplateManager = React.lazy(() => import('./InviteTemplateManager').then(m => ({ default: m.InviteTemplateManager })));
const SendingStatusTracker = React.lazy(() => import('./SendingStatusTracker').then(m => ({ default: m.SendingStatusTracker })));
const OpenLinksPanel = React.lazy(() => import('./OpenLinksPanel').then(m => ({ default: m.OpenLinksPanel })));

interface EventInvitesTabProps {
  eventId: string;
  eventUuid: string;
  event: any;
  eventTitle: string;
  eventStart: string;
  eventEnd: string;
}

interface InviteParty {
  id: string;
  name: string;
  status: string;
  short_code: string;
  created_at: string;
  event_ids: string[];
  member_count: number;
  accepted_count: number;
  declined_count: number;
  pending_count: number;
  lead_first_name: string | null;
  lead_last_name: string | null;
  lead_email: string | null;
  [key: string]: unknown;
}

interface DeleteModalState {
  isOpen: boolean;
  partyId: string | null;
  partyName: string;
}

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'opened', label: 'Opened' },
  { value: 'partially_responded', label: 'Partially Responded' },
  { value: 'responded', label: 'Responded' },
] as const;

const STATUS_COLORS: Record<string, string> = {
  draft: 'gray',
  sent: 'blue',
  send_failed: 'red',
  opened: 'yellow',
  partially_responded: 'orange',
  responded: 'green',
  expired: 'gray',
  cancelled: 'red',
};

const SUB_TABS = [
  { id: 'rsvps', label: 'RSVPs', icon: InboxIcon },
  { id: 'templates', label: 'Templates', icon: DocumentTextIcon },
  { id: 'sending', label: 'Sending', icon: PaperAirplaneIcon },
  { id: 'settings', label: 'Settings', icon: Cog6ToothIcon },
] as const;

type SubTabId = typeof SUB_TABS[number]['id'];

export default function EventInvitesTab({
  eventUuid,
}: EventInvitesTabProps) {
  const [activeSubTab, setActiveSubTab] = useState<SubTabId>('rsvps');
  const [parties, setParties] = useState<InviteParty[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  // Single-select RSVP response filter applied client-side to the loaded
  // parties. Click a chip to toggle it on; click the same chip again (or
  // a different one) to swap/clear. Server-side `statusFilter` already
  // filters by party draft/sent state — this is a separate dimension.
  const [rsvpFilter, setRsvpFilter] = useState<'accepted' | 'declined' | 'pending' | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createMode, setCreateMode] = useState<'individual' | 'csv'>('individual');
  const [selectedParty, setSelectedParty] = useState<InviteParty | null>(null);
  const [deleteModal, setDeleteModal] = useState<DeleteModalState>({
    isOpen: false,
    partyId: null,
    partyName: '',
  });
  const [sendingAll, setSendingAll] = useState(false);
  const [backfillingGeocoding, setBackfillingGeocoding] = useState(false);

  // Base portal URL — `window.location.origin` is a last resort and
  // gives the admin subdomain, which is wrong for RSVP links. Prefer
  // the Vite-injected value set by the admin's entrypoint.
  const basePortalUrl =
    import.meta.env.VITE_PORTAL_URL ||
    import.meta.env.VITE_APP_URL ||
    window.location.origin;

  // If this event has a custom domain configured, RSVP links / QR codes
  // / PDF variables should point there instead of the generic brand
  // portal. The custom-domains module exposes a lookup endpoint; when
  // it's enabled and the lookup returns a url, we swap it in for every
  // `${portalUrl}/rsvp/...` composition below.
  const [customDomainUrl, setCustomDomainUrl] = useState<string | null>(null);
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL || '';
    if (!apiUrl) return;
    (async () => {
      try {
        const token = (await supabase.auth.getSession()).data.session?.access_token;
        const res = await fetch(
          `${apiUrl}/api/modules/custom-domains/lookup/events/${eventUuid}`,
          token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
        );
        if (!res.ok) return;
        const data = await res.json();
        if (data?.url) setCustomDomainUrl(data.url as string);
      } catch {
        /* module not enabled — ignore */
      }
    })();
  }, [eventUuid]);

  const portalUrl = customDomainUrl || basePortalUrl;

  const loadParties = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase
        .from('invite_parties_with_stats')
        .select('*')
        .contains('event_ids', [eventUuid]);

      if (statusFilter) {
        query = query.eq('status', statusFilter);
      }

      if (searchQuery.trim()) {
        const term = `%${searchQuery.trim()}%`;
        query = query.or(
          `lead_email.ilike.${term},lead_first_name.ilike.${term},lead_last_name.ilike.${term}`
        );
      }

      query = query.order('created_at', { ascending: false });

      const { data, error } = await query;

      if (error) throw error;
      setParties((data as InviteParty[]) ?? []);
    } catch (err) {
      console.error('Failed to load invite parties:', err);
      toast.error('Failed to load invite parties');
    } finally {
      setLoading(false);
    }
  }, [eventUuid, statusFilter, searchQuery]);

  useEffect(() => {
    loadParties();
  }, [loadParties]);

  // Stats derived from loaded data
  const totalParties = parties.length;
  const totalPeople = parties.reduce((sum, p) => sum + (p.member_count ?? 0), 0);
  const totalAccepted = parties.reduce((sum, p) => sum + (p.accepted_count ?? 0), 0);
  const totalDeclined = parties.reduce((sum, p) => sum + (p.declined_count ?? 0), 0);
  const totalPending = parties.reduce((sum, p) => sum + (p.pending_count ?? 0), 0);

  // Parties shown in the table — filtered client-side by the chip
  // selected in the right-hand stats panel. Filter semantics: show
  // parties that have AT LEAST ONE member in the chosen state. A party
  // can show up under multiple filters (e.g. 3 accepted + 1 pending
  // appears under both 'accepted' and 'pending') — that's intentional,
  // matches the operator mental model of "show me parties where someone
  // still hasn't responded" rather than "all responses are X".
  const displayedParties = rsvpFilter
    ? parties.filter((p) => {
        if (rsvpFilter === 'accepted') return (p.accepted_count ?? 0) > 0;
        if (rsvpFilter === 'declined') return (p.declined_count ?? 0) > 0;
        if (rsvpFilter === 'pending') return (p.pending_count ?? 0) > 0;
        return true;
      })
    : parties;

  const handleCopyLink = useCallback(
    (party: InviteParty) => {
      const url = `${portalUrl}/rsvp/${party.short_code}`;
      navigator.clipboard.writeText(url).then(
        () => toast.success('Invite link copied to clipboard'),
        () => toast.error('Failed to copy link')
      );
    },
    [portalUrl]
  );

  const handleDelete = useCallback(async () => {
    if (!deleteModal.partyId) return;
    try {
      const { error } = await supabase
        .from('invite_parties')
        .delete()
        .eq('id', deleteModal.partyId);

      if (error) throw error;
      toast.success('Party deleted');
      setDeleteModal({ isOpen: false, partyId: null, partyName: '' });
      loadParties();
    } catch (err) {
      console.error('Failed to delete party:', err);
      toast.error('Failed to delete party');
    }
  }, [deleteModal.partyId, loadParties]);

  const handleSendParty = useCallback(
    async (partyId: string) => {
      try {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
        const response = await fetch(
          `${supabaseUrl}/functions/v1/event-invite-admin`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
            },
            body: JSON.stringify({
              action: 'send',
              party_ids: [partyId],
              template_id: null,
            }),
          }
        );

        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error || 'Failed to send invite');
        }

        toast.success('Invite sent');
        loadParties();
      } catch (err: any) {
        console.error('Failed to send invite:', err);
        toast.error(err.message || 'Failed to send invite');
      }
    },
    [loadParties]
  );

  const handleSendAllDraft = useCallback(async () => {
    const draftIds = parties
      .filter((p) => p.status === 'draft')
      .map((p) => p.id);

    if (draftIds.length === 0) {
      toast.info('No draft parties to send');
      return;
    }

    setSendingAll(true);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const response = await fetch(
        `${supabaseUrl}/functions/v1/event-invite-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
          },
          body: JSON.stringify({
            action: 'send',
            party_ids: draftIds,
            template_id: null,
          }),
        }
      );

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || 'Failed to send invites');
      }

      toast.success(`${draftIds.length} invite(s) sent`);
      loadParties();
    } catch (err: any) {
      console.error('Failed to send all draft invites:', err);
      toast.error(err.message || 'Failed to send invites');
    } finally {
      setSendingAll(false);
    }
  }, [parties, loadParties]);

  const handleBackfillGeocoding = useCallback(async () => {
    setBackfillingGeocoding(true);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const response = await fetch(
        `${supabaseUrl}/functions/v1/event-invite-admin`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
          },
          body: JSON.stringify({ action: 'backfill-geocoding', event_id: eventUuid }),
        }
      );
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.message || body?.error || 'Backfill failed');
      }
      const { processed = 0, geocoded = 0, routed = 0, failed = 0, skipped = 0 } = body || {};
      toast.success(
        `Backfill complete: ${geocoded} geocoded, ${routed} routed, ${skipped} already cached, ${failed} failed (${processed} total)`
      );
    } catch (err: any) {
      console.error('Backfill geocoding failed:', err);
      toast.error(err.message || 'Backfill failed');
    } finally {
      setBackfillingGeocoding(false);
    }
  }, [eventUuid]);

  const openCreateModal = useCallback((mode: 'individual' | 'csv') => {
    setCreateMode(mode);
    setShowCreateModal(true);
  }, []);

  const formatLeadBooker = (party: InviteParty): string => {
    const parts = [party.lead_first_name, party.lead_last_name].filter(Boolean);
    if (parts.length > 0) return parts.join(' ');
    return party.lead_email || '--';
  };

  const formatDate = (dateStr: string): string => {
    try {
      return new Date(dateStr).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  const formatStatusLabel = (status: string): string => {
    return status
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  };

  const getRowActions = (party: InviteParty) => [
    {
      label: 'Copy Link',
      icon: <ClipboardDocumentIcon className="w-4 h-4" />,
      onClick: () => handleCopyLink(party),
    },
    {
      label: 'View Details',
      icon: <EyeIcon className="w-4 h-4" />,
      onClick: () => setSelectedParty(party),
    },
    {
      label: 'Send',
      icon: <PaperAirplaneIcon className="w-4 h-4" />,
      onClick: () => handleSendParty(party.id),
      hidden: party.status !== 'draft',
    },
    {
      label: 'Delete',
      icon: <TrashIcon className="w-4 h-4" />,
      onClick: () =>
        setDeleteModal({
          isOpen: true,
          partyId: party.id,
          partyName: party.name || formatLeadBooker(party),
        }),
      color: 'red' as const,
    },
  ];

  const draftCount = parties.filter((p) => p.status === 'draft').length;

  return (
    <div className="space-y-4">
      {/* Sub-tab navigation */}
      <div className="flex gap-1 p-1 bg-[var(--gray-3)] rounded-lg w-fit">
        {SUB_TABS.map(tab => {
          const Icon = tab.icon;
          const isActive = activeSubTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveSubTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors cursor-pointer ${
                isActive
                  ? 'bg-[var(--color-background)] text-[var(--gray-12)] shadow-sm'
                  : 'text-[var(--gray-9)] hover:text-[var(--gray-12)]'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* RSVPs sub-tab */}
      {activeSubTab === 'rsvps' && (
        <div className="space-y-4">
          {/* Stats row — left side is read-only counts (Parties +
              People), right side is clickable RSVP filter chips
              (Accepted / Declined / Pending). Click a chip to filter
              the table below to parties with at least one member in
              that response state; click the same chip again to clear. */}
          <Card className="px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[var(--gray-11)]">Parties</span>
                  <span className="font-semibold text-[var(--gray-12)] tabular-nums">{totalParties}</span>
                </div>
                <div className="h-4 w-px bg-[var(--gray-6)]" />
                <div className="flex items-center gap-2">
                  <span className="text-[var(--gray-11)]">People</span>
                  <span className="font-semibold text-[var(--gray-12)] tabular-nums">{totalPeople}</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 ml-auto">
                <RsvpFilterChip
                  label="Accepted"
                  count={totalAccepted}
                  colorClass="text-[var(--green-11)]"
                  selectedRingClass="ring-[var(--green-8)] bg-[var(--green-3)]"
                  active={rsvpFilter === 'accepted'}
                  onToggle={() => setRsvpFilter(rsvpFilter === 'accepted' ? null : 'accepted')}
                />
                <RsvpFilterChip
                  label="Declined"
                  count={totalDeclined}
                  colorClass="text-[var(--red-11)]"
                  selectedRingClass="ring-[var(--red-8)] bg-[var(--red-3)]"
                  active={rsvpFilter === 'declined'}
                  onToggle={() => setRsvpFilter(rsvpFilter === 'declined' ? null : 'declined')}
                />
                <RsvpFilterChip
                  label="Pending"
                  count={totalPending}
                  colorClass="text-[var(--orange-11)]"
                  selectedRingClass="ring-[var(--orange-8)] bg-[var(--orange-3)]"
                  active={rsvpFilter === 'pending'}
                  onToggle={() => setRsvpFilter(rsvpFilter === 'pending' ? null : 'pending')}
                />
              </div>
            </div>
          </Card>

          {/* Action buttons */}
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => openCreateModal('individual')}>
              <PlusIcon className="w-4 h-4" />
              Create Party
            </Button>
            <Button variant="outline" onClick={() => openCreateModal('csv')}>
              <ArrowUpTrayIcon className="w-4 h-4" />
              Import CSV
            </Button>
          </div>

          {/* Search and filter */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--gray-9)]" />
              <input
                type="text"
                placeholder="Search by name or email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-md border border-[var(--gray-6)] bg-[var(--color-background)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-7)]"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-2 rounded-md border border-[var(--gray-6)] bg-[var(--color-background)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-7)]"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Party list table */}
          <Card className="overflow-hidden">
            <ScrollableTable>
              <Table>
                <THead>
                  <Tr>
                    <Th>Party Name</Th>
                    <Th>Lead Booker</Th>
                    <Th>Members</Th>
                    <Th>Status</Th>
                    <Th>Short Code</Th>
                    <Th>Created</Th>
                    <Th style={{ width: 60 }}>Actions</Th>
                  </Tr>
                </THead>
                <TBody>
                  {loading ? (
                    <Tr>
                      <Td colSpan={7}>
                        <div className="flex items-center justify-center py-8 text-[var(--gray-9)]">
                          Loading...
                        </div>
                      </Td>
                    </Tr>
                  ) : displayedParties.length === 0 ? (
                    <Tr>
                      <Td colSpan={7}>
                        <div className="flex flex-col items-center justify-center py-12 text-[var(--gray-9)]">
                          <UserGroupIcon className="w-10 h-10 mb-2 opacity-40" />
                          <p className="text-sm">No invite parties found</p>
                          {(searchQuery || statusFilter || rsvpFilter) && (
                            <p className="text-xs mt-1">
                              {rsvpFilter && parties.length > 0
                                ? `No parties with ${rsvpFilter} responses — click the chip again to clear the filter`
                                : 'Try adjusting your search or filter'}
                            </p>
                          )}
                        </div>
                      </Td>
                    </Tr>
                  ) : (
                    displayedParties.map((party) => (
                      <Tr key={party.id}>
                        <Td>{party.name || '--'}</Td>
                        <Td>
                          <div>
                            <div className="font-medium">
                              {[party.lead_first_name, party.lead_last_name]
                                .filter(Boolean)
                                .join(' ') || '--'}
                            </div>
                            {party.lead_email && (
                              <div className="text-xs text-[var(--gray-9)]">
                                {party.lead_email}
                              </div>
                            )}
                          </div>
                        </Td>
                        <Td>
                          <span className="tabular-nums">{party.member_count ?? 0}</span>
                        </Td>
                        <Td>
                          <Badge
                            color={STATUS_COLORS[party.status] as any}
                            variant="soft"
                          >
                            {formatStatusLabel(party.status)}
                          </Badge>
                        </Td>
                        <Td>
                          <code className="text-xs bg-[var(--gray-a3)] px-1.5 py-0.5 rounded">
                            {party.short_code}
                          </code>
                        </Td>
                        <Td>
                          <span className="text-sm text-[var(--gray-11)]">
                            {formatDate(party.created_at)}
                          </span>
                        </Td>
                        <Td>
                          <RowActions actions={getRowActions(party)} />
                        </Td>
                      </Tr>
                    ))
                  )}
                </TBody>
              </Table>
            </ScrollableTable>
          </Card>

          {/* Per-person RSVP table with CSV export */}
          <Suspense fallback={<div className="text-sm text-[var(--gray-a9)] py-4">Loading RSVPs...</div>}>
            <RsvpResponsesTable eventUuid={eventUuid} />
          </Suspense>

          {/* Question-response analytics */}
          <Suspense fallback={<div className="text-sm text-[var(--gray-a9)] py-4">Loading responses...</div>}>
            <ResponseDashboard eventUuid={eventUuid} />
          </Suspense>
        </div>
      )}

      {/* Templates sub-tab */}
      {activeSubTab === 'templates' && (
        <Suspense fallback={<div className="text-sm text-[var(--gray-a9)] py-4">Loading templates...</div>}>
          <InviteTemplateManager eventUuid={eventUuid} />
        </Suspense>
      )}

      {/* Sending sub-tab */}
      {activeSubTab === 'sending' && (
        <div className="space-y-4">
          <Card className="p-4">
            <h3 className="text-sm font-semibold text-[var(--gray-12)] mb-2">Send Invites</h3>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={handleSendAllDraft}
                disabled={draftCount === 0 || sendingAll}
              >
                <EnvelopeIcon className="w-4 h-4" />
                {sendingAll ? 'Sending...' : `Send All Draft (${draftCount})`}
              </Button>
              <Suspense fallback={null}>
                <QrCodeExport eventUuid={eventUuid} />
                <InvitePdfGenerator eventUuid={eventUuid} portalUrl={portalUrl} />
                <EnvelopePdfGenerator eventUuid={eventUuid} />
              </Suspense>
              <Button
                variant="outline"
                onClick={handleBackfillGeocoding}
                disabled={backfillingGeocoding}
                title="Geocode all party addresses + compute drive-time to venue ahead of time, so the first invite send isn't blocked on per-party Nominatim calls."
              >
                {backfillingGeocoding ? 'Backfilling…' : 'Backfill geocoding'}
              </Button>
            </div>
            <p className="text-xs text-[var(--gray-9)] mt-3">
              Send All Draft uses each party&apos;s configured channel. Print generates PDFs using the active PDF template.
              Backfill geocoding warms the address-to-venue cache (~1.1 sec per party); recommended before the first send for events with many invites.
            </p>
          </Card>

          <Suspense fallback={<div className="text-sm text-[var(--gray-a9)] py-4">Loading open links...</div>}>
            <OpenLinksPanel eventUuid={eventUuid} />
          </Suspense>

          <Suspense fallback={<div className="text-sm text-[var(--gray-a9)] py-4">Loading sending status...</div>}>
            <SendingStatusTracker eventUuid={eventUuid} />
          </Suspense>

          <Suspense fallback={<div className="text-sm text-[var(--gray-a9)] py-4">Loading reminders...</div>}>
            <ReminderConfigPanel eventUuid={eventUuid} />
          </Suspense>
        </div>
      )}

      {/* Settings sub-tab */}
      {activeSubTab === 'settings' && (
        <Suspense fallback={<div className="text-sm text-[var(--gray-a9)] py-4">Loading settings...</div>}>
          <div className="space-y-6">
            <SubEventConfigPanel eventUuid={eventUuid} />
            <QuestionConfigPanel eventUuid={eventUuid} />
          </div>
        </Suspense>
      )}

      {/* Create Party Modal */}
      <CreatePartyModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        eventUuid={eventUuid}
        mode={createMode}
        onSuccess={loadParties}
      />

      {/* Party Detail Modal */}
      {selectedParty && (
        <PartyDetailModal
          party={selectedParty}
          onClose={() => setSelectedParty(null)}
          onUpdate={loadParties}
          portalUrl={portalUrl}
        />
      )}

      {/* Delete Confirmation */}
      <ConfirmModal
        isOpen={deleteModal.isOpen}
        onClose={() =>
          setDeleteModal({ isOpen: false, partyId: null, partyName: '' })
        }
        onConfirm={handleDelete}
        title="Delete Party"
        message={`Are you sure you want to delete "${deleteModal.partyName}"? This will also remove all members and their responses. This action cannot be undone.`}
        confirmText="Delete"
        confirmColor="red"
      />
    </div>
  );
}

interface RsvpFilterChipProps {
  label: string;
  count: number;
  /** Tailwind class for the count number's color when inactive. */
  colorClass: string;
  /** Tailwind classes applied when the chip is the active filter. */
  selectedRingClass: string;
  active: boolean;
  onToggle: () => void;
}

/**
 * Stat chip that doubles as a filter toggle. Renders as a flat
 * label + count pair when inactive; gains a tinted background and a
 * 1px ring when active. Click anywhere on the chip to toggle. The
 * `tabular-nums` class on the count keeps the chip width stable as
 * the number changes during filtering.
 */
function RsvpFilterChip({
  label,
  count,
  colorClass,
  selectedRingClass,
  active,
  onToggle,
}: RsvpFilterChipProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      title={
        active
          ? `Showing parties with ${label.toLowerCase()} responses — click to clear`
          : `Click to show only parties with ${label.toLowerCase()} responses`
      }
      className={[
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm transition-colors cursor-pointer',
        'hover:bg-[var(--gray-3)]',
        active ? `ring-1 ${selectedRingClass}` : 'ring-0',
      ].join(' ')}
    >
      <span className="text-[var(--gray-11)]">{label}</span>
      <span className={`font-semibold tabular-nums ${colorClass}`}>{count}</span>
    </button>
  );
}
