import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Page } from '@/components/shared/Page';
import { Card, Badge, Button, Table, THead, TBody, Tr, Th, Td, Modal, ConfirmModal } from '@/components/ui';
import { ScrollableTable } from '@/components/shared/table/ScrollableTable';
import { RowActions } from '@/components/shared/table/RowActions';
import {
  EnvelopeIcon,
  PlusIcon,
  ClipboardDocumentIcon,
  TrashIcon,
  ArrowPathIcon,
  MagnifyingGlassIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  EyeIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';

interface EventInvite {
  id: string;
  event_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  token: string;
  status: string;
  rsvp_response: string | null;
  rsvp_message: string | null;
  rsvp_responded_at: string | null;
  sent_at: string | null;
  opened_at: string | null;
  expires_at: string | null;
  total_clicks: number;
  last_clicked_at: string | null;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields from view
  event_title?: string;
  event_start?: string;
  event_end?: string;
  event_location?: string;
  profile_first_name?: string;
  profile_last_name?: string;
  profile_company?: string;
  profile_job_title?: string;
  batch_name?: string;
}

interface EventOption {
  event_id: string;
  event_title: string;
  event_start: string;
}

interface InviteStats {
  total: number;
  pending: number;
  sent: number;
  accepted: number;
  declined: number;
  opened: number;
}

const STATUS_COLORS: Record<string, 'green' | 'yellow' | 'red' | 'blue' | 'gray' | 'orange'> = {
  pending: 'gray',
  sent: 'blue',
  opened: 'yellow',
  accepted: 'green',
  declined: 'red',
  expired: 'orange',
  cancelled: 'gray',
};

const RSVP_COLORS: Record<string, 'green' | 'red' | 'yellow'> = {
  yes: 'green',
  no: 'red',
  maybe: 'yellow',
};

export default function EventInvitesPage() {
  const [invites, setInvites] = useState<EventInvite[]>([]);
  const [events, setEvents] = useState<EventOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedEvent, setSelectedEvent] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [stats, setStats] = useState<InviteStats>({ total: 0, pending: 0, sent: 0, accepted: 0, declined: 0, opened: 0 });

  // Create invite modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createEventId, setCreateEventId] = useState('');
  const [createEmails, setCreateEmails] = useState('');
  const [creating, setCreating] = useState(false);

  // Delete confirmation
  const [deleteModal, setDeleteModal] = useState<{ isOpen: boolean; inviteId: string | null; inviteName: string }>({
    isOpen: false,
    inviteId: null,
    inviteName: '',
  });

  // Detail modal
  const [detailInvite, setDetailInvite] = useState<EventInvite | null>(null);

  const baseUrl = import.meta.env.VITE_PORTAL_URL || import.meta.env.VITE_APP_URL || window.location.origin;

  const loadEvents = useCallback(async () => {
    const { data } = await supabase
      .from('events')
      .select('event_id, event_title, event_start')
      .order('event_start', { ascending: false })
      .limit(100);
    if (data) setEvents(data);
  }, []);

  const loadInvites = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase
        .from('module_event_invites_with_details')
        .select('*')
        .order('created_at', { ascending: false });

      if (selectedEvent) {
        query = query.eq('event_id', selectedEvent);
      }
      if (statusFilter) {
        query = query.eq('status', statusFilter);
      }
      if (searchQuery) {
        query = query.or(`email.ilike.%${searchQuery}%,first_name.ilike.%${searchQuery}%,last_name.ilike.%${searchQuery}%`);
      }

      const { data, error } = await query.limit(500);
      if (error) throw error;

      const items = (data || []) as EventInvite[];
      setInvites(items);

      // Calculate stats
      setStats({
        total: items.length,
        pending: items.filter(i => i.status === 'pending').length,
        sent: items.filter(i => i.status === 'sent').length,
        accepted: items.filter(i => i.status === 'accepted').length,
        declined: items.filter(i => i.status === 'declined').length,
        opened: items.filter(i => i.status === 'opened').length,
      });
    } catch (error) {
      console.error('Error loading invites:', error);
      toast.error('Failed to load invites');
    } finally {
      setLoading(false);
    }
  }, [selectedEvent, statusFilter, searchQuery]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    loadInvites();
  }, [loadInvites]);

  const generateToken = (): string => {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
  };

  const handleCreateInvites = async () => {
    if (!createEventId) {
      toast.error('Please select an event');
      return;
    }

    const emails = createEmails
      .split(/[\n,;]+/)
      .map(e => e.trim().toLowerCase())
      .filter(e => e && e.includes('@'));

    if (emails.length === 0) {
      toast.error('Please enter at least one valid email address');
      return;
    }

    setCreating(true);
    try {
      // Check for existing invites to avoid duplicates
      const { data: existing } = await supabase
        .from('module_event_invites')
        .select('email')
        .eq('event_id', createEventId)
        .in('email', emails);

      const existingEmails = new Set((existing || []).map(e => e.email));
      const newEmails = emails.filter(e => !existingEmails.has(e));

      if (newEmails.length === 0) {
        toast.error('All emails already have invites for this event');
        setCreating(false);
        return;
      }

      // Create a batch if more than one invite
      let batchId: string | null = null;
      if (newEmails.length > 1) {
        const { data: batch, error: batchError } = await supabase
          .from('module_event_invite_batches')
          .insert({
            event_id: createEventId,
            name: `Batch of ${newEmails.length} invites`,
            total_invites: newEmails.length,
          })
          .select('id')
          .single();

        if (batchError) throw batchError;
        batchId = batch.id;
      }

      // Look up existing profiles for these emails
      const { data: profiles } = await supabase
        .from('people_profiles')
        .select('id, email, first_name, last_name')
        .in('email', newEmails);

      const profileMap = new Map((profiles || []).map(p => [p.email, p]));

      // Create invites
      const inviteRows = newEmails.map(email => {
        const profile = profileMap.get(email);
        return {
          event_id: createEventId,
          email,
          first_name: profile?.first_name || null,
          last_name: profile?.last_name || null,
          people_profile_id: profile?.id || null,
          token: generateToken(),
          status: 'pending',
          batch_id: batchId,
        };
      });

      const { error } = await supabase
        .from('module_event_invites')
        .insert(inviteRows);

      if (error) throw error;

      const skipped = existingEmails.size;
      toast.success(
        `Created ${newEmails.length} invite${newEmails.length === 1 ? '' : 's'}` +
        (skipped > 0 ? ` (${skipped} duplicate${skipped === 1 ? '' : 's'} skipped)` : '')
      );

      setShowCreateModal(false);
      setCreateEmails('');
      setCreateEventId('');
      loadInvites();
    } catch (error) {
      console.error('Error creating invites:', error);
      toast.error('Failed to create invites');
    } finally {
      setCreating(false);
    }
  };

  const handleCopyLink = (invite: EventInvite) => {
    const url = `${baseUrl}/invite/${invite.token}`;
    navigator.clipboard.writeText(url);
    toast.success('RSVP link copied to clipboard');
  };

  const handleMarkSent = async (inviteId: string) => {
    const { error } = await supabase
      .from('module_event_invites')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', inviteId);

    if (error) {
      toast.error('Failed to update invite');
    } else {
      toast.success('Invite marked as sent');
      loadInvites();
    }
  };

  const handleDelete = async () => {
    if (!deleteModal.inviteId) return;

    const { error } = await supabase
      .from('module_event_invites')
      .delete()
      .eq('id', deleteModal.inviteId);

    if (error) {
      toast.error('Failed to delete invite');
    } else {
      toast.success('Invite deleted');
      setDeleteModal({ isOpen: false, inviteId: null, inviteName: '' });
      loadInvites();
    }
  };

  const handleBulkCopyLinks = () => {
    const links = invites
      .filter(i => i.status === 'pending' || i.status === 'sent')
      .map(i => `${i.email}\t${baseUrl}/invite/${i.token}`)
      .join('\n');

    if (!links) {
      toast.error('No pending/sent invites to copy');
      return;
    }

    navigator.clipboard.writeText(links);
    toast.success('All invite links copied (tab-separated with emails)');
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getDisplayName = (invite: EventInvite) => {
    const first = invite.first_name || invite.profile_first_name;
    const last = invite.last_name || invite.profile_last_name;
    if (first || last) return `${first || ''} ${last || ''}`.trim();
    return invite.email;
  };

  return (
    <Page title="Event Invites">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[var(--gray-12)]">Event Invites</h1>
            <p className="text-sm text-[var(--gray-11)] mt-1">
              Invite people to events with unique RSVP links
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="soft" onClick={handleBulkCopyLinks}>
              <ClipboardDocumentIcon className="w-4 h-4 mr-1" />
              Copy All Links
            </Button>
            <Button onClick={() => setShowCreateModal(true)}>
              <PlusIcon className="w-4 h-4 mr-1" />
              Create Invites
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          {[
            { label: 'Total', value: stats.total, icon: EnvelopeIcon, color: 'var(--gray-11)' },
            { label: 'Pending', value: stats.pending, icon: ClockIcon, color: 'var(--gray-9)' },
            { label: 'Sent', value: stats.sent, icon: EnvelopeIcon, color: 'var(--blue-9)' },
            { label: 'Opened', value: stats.opened, icon: EyeIcon, color: 'var(--yellow-9)' },
            { label: 'Accepted', value: stats.accepted, icon: CheckCircleIcon, color: 'var(--green-9)' },
            { label: 'Declined', value: stats.declined, icon: XCircleIcon, color: 'var(--red-9)' },
          ].map(stat => (
            <Card key={stat.label} className="p-3">
              <div className="flex items-center gap-2">
                <stat.icon className="w-4 h-4" style={{ color: stat.color }} />
                <span className="text-xs text-[var(--gray-11)]">{stat.label}</span>
              </div>
              <p className="text-xl font-bold text-[var(--gray-12)] mt-1">{stat.value}</p>
            </Card>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--gray-9)]" />
            <input
              type="text"
              placeholder="Search by name or email..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
            />
          </div>

          <select
            value={selectedEvent}
            onChange={e => setSelectedEvent(e.target.value)}
            className="px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
          >
            <option value="">All Events</option>
            {events.map(ev => (
              <option key={ev.event_id} value={ev.event_id}>
                {ev.event_title}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
          >
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="sent">Sent</option>
            <option value="opened">Opened</option>
            <option value="accepted">Accepted</option>
            <option value="declined">Declined</option>
            <option value="expired">Expired</option>
            <option value="cancelled">Cancelled</option>
          </select>

          <Button variant="soft" onClick={loadInvites}>
            <ArrowPathIcon className="w-4 h-4" />
          </Button>
        </div>

        {/* Invites Table */}
        <ScrollableTable>
          <Table>
            <THead>
              <Tr>
                <Th>Name / Email</Th>
                <Th>Event</Th>
                <Th>Status</Th>
                <Th>RSVP</Th>
                <Th>Clicks</Th>
                <Th>Created</Th>
                <Th className="w-10"></Th>
              </Tr>
            </THead>
            <TBody>
              {loading ? (
                <Tr>
                  <Td colSpan={7} className="text-center py-8 text-[var(--gray-9)]">
                    Loading invites...
                  </Td>
                </Tr>
              ) : invites.length === 0 ? (
                <Tr>
                  <Td colSpan={7} className="text-center py-8 text-[var(--gray-9)]">
                    No invites found. Create your first invite to get started.
                  </Td>
                </Tr>
              ) : (
                invites.map(invite => (
                  <Tr key={invite.id}>
                    <Td>
                      <div>
                        <div className="font-medium text-[var(--gray-12)]">{getDisplayName(invite)}</div>
                        {(invite.first_name || invite.profile_first_name) && (
                          <div className="text-xs text-[var(--gray-9)]">{invite.email}</div>
                        )}
                        {invite.profile_company && (
                          <div className="text-xs text-[var(--gray-9)]">{invite.profile_company}</div>
                        )}
                      </div>
                    </Td>
                    <Td>
                      <div className="text-sm text-[var(--gray-12)]">{invite.event_title || invite.event_id}</div>
                      {invite.event_start && (
                        <div className="text-xs text-[var(--gray-9)]">
                          {new Date(invite.event_start).toLocaleDateString()}
                        </div>
                      )}
                    </Td>
                    <Td>
                      <Badge color={STATUS_COLORS[invite.status] || 'gray'}>{invite.status}</Badge>
                    </Td>
                    <Td>
                      {invite.rsvp_response ? (
                        <Badge color={RSVP_COLORS[invite.rsvp_response] || 'gray'}>
                          {invite.rsvp_response}
                        </Badge>
                      ) : (
                        <span className="text-xs text-[var(--gray-9)]">—</span>
                      )}
                    </Td>
                    <Td>
                      <span className="text-sm text-[var(--gray-11)]">{invite.total_clicks}</span>
                    </Td>
                    <Td>
                      <span className="text-xs text-[var(--gray-9)]">{formatDate(invite.created_at)}</span>
                    </Td>
                    <Td>
                      <RowActions
                        actions={[
                          {
                            label: 'Copy RSVP Link',
                            icon: ClipboardDocumentIcon,
                            onClick: () => handleCopyLink(invite),
                          },
                          {
                            label: 'View Details',
                            icon: EyeIcon,
                            onClick: () => setDetailInvite(invite),
                          },
                          ...(invite.status === 'pending'
                            ? [{
                                label: 'Mark as Sent',
                                icon: EnvelopeIcon,
                                onClick: () => handleMarkSent(invite.id),
                              }]
                            : []),
                          {
                            label: 'Delete',
                            icon: TrashIcon,
                            onClick: () =>
                              setDeleteModal({
                                isOpen: true,
                                inviteId: invite.id,
                                inviteName: getDisplayName(invite),
                              }),
                            danger: true,
                          },
                        ]}
                      />
                    </Td>
                  </Tr>
                ))
              )}
            </TBody>
          </Table>
        </ScrollableTable>

        {/* Create Invites Modal */}
        <Modal
          isOpen={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          title="Create Event Invites"
        >
          <div className="space-y-4 p-4">
            <div>
              <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Event</label>
              <select
                value={createEventId}
                onChange={e => setCreateEventId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
              >
                <option value="">Select an event...</option>
                {events.map(ev => (
                  <option key={ev.event_id} value={ev.event_id}>
                    {ev.event_title} ({new Date(ev.event_start).toLocaleDateString()})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">
                Email Addresses
              </label>
              <textarea
                value={createEmails}
                onChange={e => setCreateEmails(e.target.value)}
                placeholder="Enter email addresses (one per line, or comma/semicolon separated)"
                rows={6}
                className="w-full px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)] resize-y"
              />
              <p className="text-xs text-[var(--gray-9)] mt-1">
                Each email will get a unique RSVP link. Existing profiles will be auto-linked.
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="soft" onClick={() => setShowCreateModal(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreateInvites} disabled={creating}>
                {creating ? 'Creating...' : 'Create Invites'}
              </Button>
            </div>
          </div>
        </Modal>

        {/* Detail Modal */}
        <Modal
          isOpen={!!detailInvite}
          onClose={() => setDetailInvite(null)}
          title="Invite Details"
        >
          {detailInvite && (
            <div className="space-y-4 p-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-xs text-[var(--gray-9)]">Name</span>
                  <p className="text-sm font-medium text-[var(--gray-12)]">{getDisplayName(detailInvite)}</p>
                </div>
                <div>
                  <span className="text-xs text-[var(--gray-9)]">Email</span>
                  <p className="text-sm text-[var(--gray-12)]">{detailInvite.email}</p>
                </div>
                <div>
                  <span className="text-xs text-[var(--gray-9)]">Event</span>
                  <p className="text-sm text-[var(--gray-12)]">{detailInvite.event_title || detailInvite.event_id}</p>
                </div>
                <div>
                  <span className="text-xs text-[var(--gray-9)]">Status</span>
                  <p><Badge color={STATUS_COLORS[detailInvite.status] || 'gray'}>{detailInvite.status}</Badge></p>
                </div>
                <div>
                  <span className="text-xs text-[var(--gray-9)]">RSVP Response</span>
                  <p>
                    {detailInvite.rsvp_response ? (
                      <Badge color={RSVP_COLORS[detailInvite.rsvp_response] || 'gray'}>{detailInvite.rsvp_response}</Badge>
                    ) : (
                      <span className="text-sm text-[var(--gray-9)]">Not yet responded</span>
                    )}
                  </p>
                </div>
                <div>
                  <span className="text-xs text-[var(--gray-9)]">Total Clicks</span>
                  <p className="text-sm text-[var(--gray-12)]">{detailInvite.total_clicks}</p>
                </div>
                {detailInvite.rsvp_message && (
                  <div className="col-span-2">
                    <span className="text-xs text-[var(--gray-9)]">RSVP Message</span>
                    <p className="text-sm text-[var(--gray-12)] bg-[var(--gray-3)] p-2 rounded mt-1">
                      {detailInvite.rsvp_message}
                    </p>
                  </div>
                )}
                {detailInvite.profile_company && (
                  <div>
                    <span className="text-xs text-[var(--gray-9)]">Company</span>
                    <p className="text-sm text-[var(--gray-12)]">{detailInvite.profile_company}</p>
                  </div>
                )}
                {detailInvite.profile_job_title && (
                  <div>
                    <span className="text-xs text-[var(--gray-9)]">Job Title</span>
                    <p className="text-sm text-[var(--gray-12)]">{detailInvite.profile_job_title}</p>
                  </div>
                )}
              </div>

              <div className="border-t border-[var(--gray-6)] pt-3">
                <span className="text-xs text-[var(--gray-9)] block mb-1">Timeline</span>
                <div className="space-y-1 text-xs text-[var(--gray-11)]">
                  <div>Created: {formatDate(detailInvite.created_at)}</div>
                  {detailInvite.sent_at && <div>Sent: {formatDate(detailInvite.sent_at)}</div>}
                  {detailInvite.opened_at && <div>Opened: {formatDate(detailInvite.opened_at)}</div>}
                  {detailInvite.rsvp_responded_at && <div>RSVP: {formatDate(detailInvite.rsvp_responded_at)}</div>}
                  {detailInvite.last_clicked_at && <div>Last Click: {formatDate(detailInvite.last_clicked_at)}</div>}
                </div>
              </div>

              <div className="border-t border-[var(--gray-6)] pt-3">
                <span className="text-xs text-[var(--gray-9)] block mb-1">RSVP Link</span>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs bg-[var(--gray-3)] p-2 rounded break-all">
                    {baseUrl}/invite/{detailInvite.token}
                  </code>
                  <Button variant="soft" size="1" onClick={() => handleCopyLink(detailInvite)}>
                    <ClipboardDocumentIcon className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </Modal>

        {/* Delete Confirmation */}
        <ConfirmModal
          isOpen={deleteModal.isOpen}
          onClose={() => setDeleteModal({ isOpen: false, inviteId: null, inviteName: '' })}
          onConfirm={handleDelete}
          title="Delete Invite"
          message={`Are you sure you want to delete the invite for ${deleteModal.inviteName}? This action cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
        />
      </div>
    </Page>
  );
}
