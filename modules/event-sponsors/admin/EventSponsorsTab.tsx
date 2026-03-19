import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  PencilIcon,
  TrashIcon,
  PhotoIcon,
  PlusIcon,
  UsersIcon,
  BuildingOfficeIcon,
  QrCodeIcon,
  MagnifyingGlassIcon,
  EyeIcon,
  ArrowDownTrayIcon,
  EnvelopeIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';

import {
  Button,
  Card,
  Badge,
  Modal,
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
} from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';
import { ScrollableTable } from '@/components/shared/table/ScrollableTable';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Event } from '@/utils/eventService';
import { EventQrService, EventSponsor, Sponsor } from '@/utils/eventQrService';
import { getSponsorMediaCounts } from '@/utils/eventMediaService';
import { SendSponsorEmailModal } from '@/components/emails/SendSponsorEmailModal';

export function EventSponsorsTab({ eventId, event }: { eventId: string; event: Event | null }) {
  const navigate = useNavigate();
  const [sponsors, setSponsors] = useState<EventSponsor[]>([]);
  const [allSponsors, setAllSponsors] = useState<Sponsor[]>([]);
  const [sponsorMediaCounts, setSponsorMediaCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingSponsor, setEditingSponsor] = useState<EventSponsor | null>(null);
  const [selectedSponsorId, setSelectedSponsorId] = useState('');
  const [sponsorName, setSponsorName] = useState('');
  const [editingSponsorName, setEditingSponsorName] = useState('');
  const [sponsorDetails, setSponsorDetails] = useState({
    sponsorship_tier: '' as 'platinum' | 'gold' | 'silver' | 'bronze' | 'partner' | 'exhibitor' | 'free' | '',
    booth_number: '',
    booth_size: '',
  });

  // Team management modal state
  const [showTeamModal, setShowTeamModal] = useState(false);
  const [managingSponsor, setManagingSponsor] = useState<EventSponsor | null>(null);
  const [eventRegistrations, setEventRegistrations] = useState<any[]>([]);
  const [selectedRegistrationIds, setSelectedRegistrationIds] = useState<Set<string>>(new Set());
  const [primaryContactId, setPrimaryContactId] = useState<string | null>(null);
  const [teamModalLoading, setTeamModalLoading] = useState(false);
  const [teamSearchQuery, setTeamSearchQuery] = useState('');

  // Scans view modal state
  const [showScansModal, setShowScansModal] = useState(false);
  const [viewingSponsor, setViewingSponsor] = useState<EventSponsor | null>(null);
  const [teamStats, setTeamStats] = useState<any[]>([]);
  const [teamScans, setTeamScans] = useState<any[]>([]);
  const [scansModalLoading, setScansModalLoading] = useState(false);
  const [scanFilters, setScanFilters] = useState({
    scannerId: '',
    interestLevel: '',
    minRating: 0,
  });

  // Email modal state
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailingSponsor, setEmailingSponsor] = useState<EventSponsor | null>(null);
  const [emailTeamMembers, setEmailTeamMembers] = useState<Array<{ id: string; full_name: string; email: string }>>([]);

  useEffect(() => {
    loadSponsors();
  }, [eventId]);

  const loadSponsors = async () => {
    setLoading(true);
    try {
      const [eventSponsorsData, allSponsorsData, mediaCountsResult] = await Promise.all([
        EventQrService.getEventSponsors(eventId),
        EventQrService.getAllSponsors(),
        getSponsorMediaCounts(eventId),
      ]);
      setSponsors(eventSponsorsData);
      setAllSponsors(allSponsorsData);
      setSponsorMediaCounts(mediaCountsResult.data || {});
    } catch (error) {
      console.error('Error loading sponsors:', error);
      toast.error('Failed to load sponsors');
    } finally {
      setLoading(false);
    }
  };

  const handleAddSponsor = async () => {
    if (!selectedSponsorId && !sponsorName.trim()) {
      toast.error('Please select or enter a sponsor name');
      return;
    }

    try {
      let sponsorId = selectedSponsorId;

      // If no sponsor ID is selected, create a new sponsor
      if (!sponsorId && sponsorName.trim()) {
        const newSponsor = await EventQrService.createSponsor({
          name: sponsorName.trim(),
        });
        sponsorId = newSponsor.id;
        toast.success('New sponsor created');
      }

      await EventQrService.addEventSponsor({
        event_id: eventId,
        sponsor_id: sponsorId,
        sponsorship_tier: sponsorDetails.sponsorship_tier || undefined,
        booth_number: sponsorDetails.booth_number || undefined,
        booth_size: sponsorDetails.booth_size || undefined,
      });
      toast.success('Sponsor added to event successfully');
      setShowAddModal(false);
      setSelectedSponsorId('');
      setSponsorName('');
      setSponsorDetails({ sponsorship_tier: '', booth_number: '', booth_size: '' });
      await loadSponsors();
    } catch (error) {
      console.error('Error adding sponsor:', error);
      toast.error('Failed to add sponsor');
    }
  };

  const handleUpdateSponsor = async () => {
    if (!editingSponsor) return;

    try {
      // Update event sponsor details (tier, booth info)
      await EventQrService.updateEventSponsor(editingSponsor.id, sponsorDetails);

      // Update sponsor name if it was changed
      if (editingSponsorName && editingSponsorName !== editingSponsor.sponsor?.name) {
        await EventQrService.updateSponsorName(editingSponsor.sponsor_id, editingSponsorName);
      }

      toast.success('Sponsor updated successfully');
      setEditingSponsor(null);
      setEditingSponsorName('');
      setSponsorDetails({ sponsorship_tier: '', booth_number: '', booth_size: '' });
      await loadSponsors();
    } catch (error) {
      console.error('Error updating sponsor:', error);
      toast.error('Failed to update sponsor');
    }
  };

  const handleRemoveSponsor = async (sponsorId: string) => {
    if (!confirm('Are you sure you want to remove this sponsor from the event?')) return;

    try {
      await EventQrService.removeEventSponsor(sponsorId);
      toast.success('Sponsor removed successfully');
      await loadSponsors();
    } catch (error) {
      console.error('Error removing sponsor:', error);
      toast.error('Failed to remove sponsor');
    }
  };

  const openEditModal = (sponsor: EventSponsor) => {
    setEditingSponsor(sponsor);
    setEditingSponsorName(sponsor.sponsor?.name || '');
    setSponsorDetails({
      sponsorship_tier: sponsor.sponsorship_tier || '',
      booth_number: sponsor.booth_number || '',
      booth_size: sponsor.booth_size || '',
    });
  };

  const handleViewMedia = (sponsorId: string) => {
    // Navigate to media tab with sponsor filter
    // We'll pass the sponsor ID via URL state
    navigate(`/events/${eventId}/media?sponsorId=${sponsorId}`);
  };

  const openTeamModal = async (sponsor: EventSponsor) => {
    setManagingSponsor(sponsor);
    setShowTeamModal(true);
    setTeamModalLoading(true);

    try {
      // Load all event registrations
      const allRegs = await EventQrService.getEventRegistrations(eventId);
      setEventRegistrations(allRegs);

      // Pre-select registrations that are already part of this team
      const teamMembers = allRegs.filter((r: any) => r.sponsor_team_id === sponsor.id);
      const teamMemberIds = new Set(teamMembers.map((r: any) => r.id));
      setSelectedRegistrationIds(teamMemberIds);

      // Find the primary contact
      const primaryContact = teamMembers.find((r: any) => r.is_primary_contact === true);
      console.log('Team members:', teamMembers.map((m: any) => ({
        id: m.id,
        name: m.full_name,
        is_primary_contact: m.is_primary_contact
      })));
      console.log('Primary contact found:', primaryContact ? { id: primaryContact.id, name: primaryContact.full_name } : 'none');
      setPrimaryContactId(primaryContact?.id || null);
    } catch (error) {
      console.error('Error loading registrations:', error);
      toast.error('Failed to load registrations');
    } finally {
      setTeamModalLoading(false);
    }
  };

  const handleSaveTeam = async () => {
    if (!managingSponsor) return;

    try {
      setTeamModalLoading(true);

      // Get current team member IDs
      const currentTeamIds = new Set(
        eventRegistrations
          .filter((r: any) => r.sponsor_team_id === managingSponsor.id)
          .map((r: any) => r.id)
      );

      // Determine which to add and which to remove
      const toAdd = Array.from(selectedRegistrationIds).filter((id) => !currentTeamIds.has(id));
      const toRemove = Array.from(currentTeamIds).filter((id) => !selectedRegistrationIds.has(id));

      // Execute updates
      if (toAdd.length > 0) {
        await EventQrService.assignRegistrationsToSponsorTeam(toAdd, managingSponsor.id);
      }
      if (toRemove.length > 0) {
        await EventQrService.removeRegistrationsFromSponsorTeam(toRemove);
      }

      // Update primary contact
      console.log('Saving primary contact:', {
        primaryContactId,
        isInTeam: primaryContactId ? selectedRegistrationIds.has(primaryContactId) : false,
        sponsorId: managingSponsor.id
      });
      if (primaryContactId && selectedRegistrationIds.has(primaryContactId)) {
        // Set the selected primary contact
        console.log('Setting primary contact:', primaryContactId);
        await EventQrService.setPrimaryContact(primaryContactId, managingSponsor.id);
      } else {
        // Clear primary contact if none is selected
        console.log('Clearing primary contact for sponsor:', managingSponsor.id);
        await EventQrService.clearPrimaryContact(managingSponsor.id);
      }

      toast.success(`Team updated: ${toAdd.length} added, ${toRemove.length} removed`);

      // Reload sponsors to refresh primary contact info
      await loadSponsors();

      setShowTeamModal(false);
      setManagingSponsor(null);
      setSelectedRegistrationIds(new Set());
      setPrimaryContactId(null);
      setTeamSearchQuery('');
    } catch (error) {
      console.error('Error saving team:', error);
      toast.error('Failed to update team');
    } finally {
      setTeamModalLoading(false);
    }
  };

  const openScansModal = async (sponsor: EventSponsor) => {
    setViewingSponsor(sponsor);
    setShowScansModal(true);
    setScansModalLoading(true);

    try {
      // Load team stats and scans
      const [stats, scans] = await Promise.all([
        EventQrService.getSponsorTeamStats(sponsor.id),
        EventQrService.getSponsorTeamScans(sponsor.id, scanFilters),
      ]);
      setTeamStats(stats);
      setTeamScans(scans);
    } catch (error) {
      console.error('Error loading scans:', error);
      toast.error('Failed to load scans');
    } finally {
      setScansModalLoading(false);
    }
  };

  const openEmailModal = async (sponsor: EventSponsor) => {
    // Load event registrations first
    try {
      const allRegs = await EventQrService.getEventRegistrations(eventId);
      setEventRegistrations(allRegs);

      // Filter and prepare team members for this sponsor
      const teamMembers = allRegs
        .filter((reg: any) => reg.sponsor_team_id === sponsor.id)
        .map((reg: any) => ({
          id: reg.id,
          full_name: reg.full_name || reg.email,
          email: reg.email,
          is_primary_contact: reg.is_primary_contact || false,
        }));

      console.log('Team members for sponsor:', sponsor.sponsor?.name, teamMembers);

      // Set all state together
      setEmailTeamMembers(teamMembers);
      setEmailingSponsor(sponsor);
      setShowEmailModal(true);
    } catch (error) {
      console.error('Error loading registrations:', error);
      toast.error('Failed to load team members');
    }
  };

  const generateScansCSV = async (sponsorId: string) => {
    try {
      const csv = await EventQrService.exportSponsorScansCSV(sponsorId);
      return csv;
    } catch (error) {
      console.error('Error generating CSV:', error);
      throw error;
    }
  };

  const generateRegistrationsCSV = async () => {
    try {
      // Fetch registrations for this event
      const allRegistrations = await EventQrService.getEventRegistrations(eventId!);

      // Filter registrations with sponsor permission
      const permittedRegistrations = allRegistrations.filter((r: any) => r.sponsor_permission === true);

      if (permittedRegistrations.length === 0) {
        // Return empty CSV with just headers
        const headers = [
          'First Name',
          'Last Name',
          'Email',
          'Company',
          'Job Title',
          'Registration Type',
          'Ticket Type',
          'Status',
          'Registered At'
        ];
        return headers.join(',');
      }

      // Create CSV headers
      const headers = [
        'First Name',
        'Last Name',
        'Email',
        'Company',
        'Job Title',
        'Registration Type',
        'Ticket Type',
        'Status',
        'Registered At'
      ];

      // Create CSV rows
      const rows = permittedRegistrations.map((reg: any) => [
        reg.first_name || '',
        reg.last_name || '',
        reg.email || '',
        reg.company || '',
        reg.job_title || '',
        reg.registration_type || '',
        reg.ticket_type || '',
        reg.status || '',
        reg.created_at ? new Date(reg.created_at).toISOString() : ''
      ]);

      // Combine headers and rows
      const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      ].join('\n');

      return csvContent;
    } catch (error) {
      console.error('Error generating registrations CSV:', error);
      throw error;
    }
  };

  const handleExportCSV = async (scannerId?: string) => {
    if (!viewingSponsor) return;

    try {
      const filters = scannerId ? { scannerId } : scanFilters;
      const csv = await EventQrService.exportSponsorScansCSV(viewingSponsor.id, filters);

      // Download CSV
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const fileName = scannerId
        ? `${viewingSponsor.sponsor?.name}_${scannerId}_scans.csv`
        : `${viewingSponsor.sponsor?.name}_all_scans.csv`;
      a.download = fileName.replace(/[^a-z0-9_.-]/gi, '_');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      toast.success('CSV exported successfully');
    } catch (error) {
      console.error('Error exporting CSV:', error);
      toast.error('Failed to export CSV');
    }
  };

  const handleDownloadSponsorCSV = async (sponsor: EventSponsor) => {
    try {
      const csv = await EventQrService.exportSponsorScansCSV(sponsor.id, {});

      // Download CSV
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const fileName = `${sponsor.sponsor?.name}_badge_scans.csv`;
      a.download = fileName.replace(/[^a-z0-9_.-]/gi, '_');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      toast.success('CSV exported successfully');
    } catch (error) {
      console.error('Error exporting CSV:', error);
      toast.error('Failed to export CSV');
    }
  };

  if (loading) {
    return (
      <Card>
        <div className="p-6 flex justify-center">
          <LoadingSpinner size="medium" />
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-[var(--gray-12)]">
              Event Sponsors ({sponsors.length})
            </h3>
            <Button variant="primary" size="sm" onClick={() => setShowAddModal(true)}>
              <PlusIcon className="w-4 h-4 mr-2" />
              Add Sponsor
            </Button>
          </div>

          {sponsors.length === 0 ? (
            <div className="text-center py-12 text-[var(--gray-a11)]">
              <BuildingOfficeIcon className="w-12 h-12 mx-auto mb-3 text-[var(--gray-a9)]" />
              <p>No sponsors assigned yet</p>
              <p className="text-sm mt-1">Add sponsors to this event to track booth leads and engagement</p>
            </div>
          ) : (
            <ScrollableTable>
              <Table>
                <THead>
                  <Tr>
                    <Th data-sticky-left style={{ position: 'sticky', left: 0, zIndex: 20, background: 'var(--color-panel-solid)' }}>Sponsor</Th>
                    <Th>Tier</Th>
                    <Th>Booth</Th>
                    <Th>Team Members</Th>
                    <Th>Badge Scans</Th>
                    <Th>Media</Th>
                    <Th>Contact</Th>
                    <Th data-sticky-right style={{ position: 'sticky', right: 0, zIndex: 20, background: 'var(--color-panel-solid)' }}>&nbsp;</Th>
                  </Tr>
                </THead>
                <TBody>
                  {sponsors.map((sponsor) => (
                    <Tr key={sponsor.id}>
                      <Td data-sticky-left style={{ position: 'sticky', left: 0, zIndex: 10, background: 'var(--color-panel-solid)' }}>
                        <div className="flex items-center">
                          {sponsor.sponsor?.logo_url && (
                            <img
                              src={sponsor.sponsor.logo_url}
                              alt={sponsor.sponsor.name}
                              className="w-10 h-10 rounded-full mr-3 object-cover"
                            />
                          )}
                          <div>
                            <div className="text-sm font-medium">
                              {sponsor.sponsor?.name}
                            </div>
                            {sponsor.sponsor?.website && (
                              <a
                                href={sponsor.sponsor.website}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-[var(--blue-11)] hover:underline"
                              >
                                {sponsor.sponsor.website}
                              </a>
                            )}
                          </div>
                        </div>
                      </Td>
                      <Td>
                        {sponsor.sponsorship_tier ? (
                          <Badge variant="soft" className="capitalize">
                            {sponsor.sponsorship_tier}
                          </Badge>
                        ) : (
                          <span className="text-sm text-[var(--gray-a11)]">-</span>
                        )}
                      </Td>
                      <Td>
                        {sponsor.booth_number ? (
                          <div>
                            <div>#{sponsor.booth_number}</div>
                            {sponsor.booth_size && (
                              <div className="text-xs text-[var(--gray-a11)]">{sponsor.booth_size}</div>
                            )}
                          </div>
                        ) : (
                          <span className="text-[var(--gray-a11)]">-</span>
                        )}
                      </Td>
                      <Td>
                        <div className="flex items-center">
                          <UsersIcon className="w-4 h-4 text-[var(--gray-a9)] mr-2" />
                          <span className="font-medium">
                            {sponsor.team_member_count || 0}
                          </span>
                        </div>
                      </Td>
                      <Td>
                        <div className="flex items-center">
                          <QrCodeIcon className="w-4 h-4 text-purple-400 mr-2" />
                          <span className="font-medium text-purple-600 dark:text-purple-400">
                            {sponsor.badge_scan_count || 0}
                          </span>
                        </div>
                      </Td>
                      <Td>
                        <Button variant="ghost" color="blue" onClick={() => handleViewMedia(sponsor.id)} title="View tagged media">
                          <PhotoIcon className="w-4 h-4 mr-2" />
                          <span className="font-medium">
                            {sponsorMediaCounts[sponsor.id] || 0}
                          </span>
                        </Button>
                      </Td>
                      <Td>
                        {sponsor.primary_contact ? (
                          <div>
                            <div className="font-medium">{sponsor.primary_contact.full_name}</div>
                            <div className="text-xs text-[var(--gray-a11)]">
                              {sponsor.primary_contact.email}
                            </div>
                          </div>
                        ) : (
                          <span className="text-[var(--gray-a11)]">-</span>
                        )}
                      </Td>
                      <Td data-sticky-right style={{ position: 'sticky', right: 0, zIndex: 10, background: 'var(--color-panel-solid)' }}>
                        <RowActions actions={[
                          { label: 'Manage Team', icon: <UsersIcon className="w-4 h-4" />, onClick: () => openTeamModal(sponsor) },
                          { label: 'View Scans', icon: <EyeIcon className="w-4 h-4" />, onClick: () => openScansModal(sponsor) },
                          { label: 'Download Badge Scans CSV', icon: <ArrowDownTrayIcon className="w-4 h-4" />, onClick: () => handleDownloadSponsorCSV(sponsor) },
                          { label: 'Email Team', icon: <EnvelopeIcon className="w-4 h-4" />, onClick: () => openEmailModal(sponsor) },
                          { label: 'Edit Sponsor', icon: <PencilIcon className="w-4 h-4" />, onClick: () => openEditModal(sponsor) },
                          { label: 'Remove Sponsor', icon: <TrashIcon className="w-4 h-4" />, onClick: () => handleRemoveSponsor(sponsor.id), color: 'red' },
                        ]} />
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </ScrollableTable>
          )}
        </div>
      </Card>

      {/* Add Sponsor Modal */}
      {showAddModal && (
        <Modal
          isOpen={showAddModal}
          onClose={() => {
            setShowAddModal(false);
            setSelectedSponsorId('');
            setSponsorName('');
            setSponsorDetails({ sponsorship_tier: '', booth_number: '', booth_size: '' });
          }}
          title="Add Sponsor to Event"
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                Sponsor Name
              </label>
              <input
                type="text"
                list="sponsor-list"
                value={sponsorName}
                onChange={(e) => {
                  const value = e.target.value;
                  setSponsorName(value);

                  // Check if the entered value matches an existing sponsor
                  const matchingSponsor = allSponsors.find(
                    (s) => s.name.toLowerCase() === value.toLowerCase() && !sponsors.some((es) => es.sponsor_id === s.id)
                  );
                  setSelectedSponsorId(matchingSponsor ? matchingSponsor.id : '');
                }}
                placeholder="Select existing or type new sponsor name..."
                className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
              />
              <datalist id="sponsor-list">
                {allSponsors
                  .filter((s) => !sponsors.some((es) => es.sponsor_id === s.id))
                  .map((sponsor) => (
                    <option key={sponsor.id} value={sponsor.name} />
                  ))}
              </datalist>
              {sponsorName && !selectedSponsorId && (
                <p className="mt-1 text-sm text-[var(--blue-11)]">
                  Will create new sponsor: "{sponsorName}"
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                Sponsorship Tier
              </label>
              <select
                value={sponsorDetails.sponsorship_tier}
                onChange={(e) => setSponsorDetails({ ...sponsorDetails, sponsorship_tier: e.target.value as any })}
                className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
              >
                <option value="">Select tier...</option>
                <option value="platinum">Platinum</option>
                <option value="gold">Gold</option>
                <option value="silver">Silver</option>
                <option value="bronze">Bronze</option>
                <option value="partner">Partner</option>
                <option value="exhibitor">Exhibitor</option>
                <option value="free">Free</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                Booth Number
              </label>
              <input
                type="text"
                value={sponsorDetails.booth_number}
                onChange={(e) => setSponsorDetails({ ...sponsorDetails, booth_number: e.target.value })}
                placeholder="e.g., A101"
                className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                Booth Size
              </label>
              <input
                type="text"
                value={sponsorDetails.booth_size}
                onChange={(e) => setSponsorDetails({ ...sponsorDetails, booth_size: e.target.value })}
                placeholder="e.g., 10x10, Large, Medium"
                className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
              />
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button
                variant="outline"
                onClick={() => {
                  setShowAddModal(false);
                  setSelectedSponsorId('');
                  setSponsorName('');
                  setSponsorDetails({ sponsorship_tier: '', booth_number: '', booth_size: '' });
                }}
              >
                Cancel
              </Button>
              <Button variant="primary" onClick={handleAddSponsor}>
                Add Sponsor
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Edit Sponsor Modal */}
      {editingSponsor && (
        <Modal
          isOpen={!!editingSponsor}
          onClose={() => {
            setEditingSponsor(null);
            setEditingSponsorName('');
            setSponsorDetails({ sponsorship_tier: '', booth_number: '', booth_size: '' });
          }}
          title={`Edit ${editingSponsor.sponsor?.name}`}
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                Sponsor Name
              </label>
              <input
                type="text"
                value={editingSponsorName}
                onChange={(e) => setEditingSponsorName(e.target.value)}
                placeholder="Enter sponsor name..."
                className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                Sponsorship Tier
              </label>
              <select
                value={sponsorDetails.sponsorship_tier}
                onChange={(e) => setSponsorDetails({ ...sponsorDetails, sponsorship_tier: e.target.value as any })}
                className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
              >
                <option value="">Select tier...</option>
                <option value="platinum">Platinum</option>
                <option value="gold">Gold</option>
                <option value="silver">Silver</option>
                <option value="bronze">Bronze</option>
                <option value="partner">Partner</option>
                <option value="exhibitor">Exhibitor</option>
                <option value="free">Free</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                Booth Number
              </label>
              <input
                type="text"
                value={sponsorDetails.booth_number}
                onChange={(e) => setSponsorDetails({ ...sponsorDetails, booth_number: e.target.value })}
                placeholder="e.g., A101"
                className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                Booth Size
              </label>
              <input
                type="text"
                value={sponsorDetails.booth_size}
                onChange={(e) => setSponsorDetails({ ...sponsorDetails, booth_size: e.target.value })}
                placeholder="e.g., 10x10, Large, Medium"
                className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
              />
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button
                variant="outline"
                onClick={() => {
                  setEditingSponsor(null);
                  setEditingSponsorName('');
                  setSponsorDetails({ sponsorship_tier: '', booth_number: '', booth_size: '' });
                }}
              >
                Cancel
              </Button>
              <Button variant="primary" onClick={handleUpdateSponsor}>
                Save Changes
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Manage Team Modal */}
      {showTeamModal && managingSponsor && (
        <Modal
          isOpen={showTeamModal}
          onClose={() => {
            setShowTeamModal(false);
            setManagingSponsor(null);
            setSelectedRegistrationIds(new Set());
            setTeamSearchQuery('');
          }}
          title={`Manage Team - ${managingSponsor.sponsor?.name}`}
          size="large"
        >
          <div className="space-y-4">
            {teamModalLoading ? (
              <div className="flex justify-center py-8">
                <LoadingSpinner size="medium" />
              </div>
            ) : (
              <>
                <p className="text-sm text-[var(--gray-a11)]">
                  Select attendees to add to this sponsor's team. Team members will be able to scan badges and view all team scans in the check-in app.
                </p>

                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <MagnifyingGlassIcon className="h-5 w-5 text-[var(--gray-a9)]" />
                  </div>
                  <input
                    type="text"
                    placeholder="Search by name, email, job title, or company..."
                    value={teamSearchQuery}
                    onChange={(e) => setTeamSearchQuery(e.target.value)}
                    className="block w-full pl-10 pr-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)] placeholder-[var(--gray-a9)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)] focus:border-transparent"
                  />
                </div>

                <div className="max-h-96 overflow-y-auto border border-[var(--gray-a6)] rounded-lg">
                  <Table>
                    <THead>
                      <Tr>
                        <Th>
                          <input
                            type="checkbox"
                            checked={(() => {
                              const filteredRegs = eventRegistrations.filter((reg: any) => {
                                if (!teamSearchQuery.trim()) return true;
                                const query = teamSearchQuery.toLowerCase();
                                const fullName = (reg.full_name || '').toLowerCase();
                                const email = (reg.email || '').toLowerCase();
                                const jobTitle = (reg.job_title || '').toLowerCase();
                                const company = (reg.company || '').toLowerCase();
                                return fullName.includes(query) || email.includes(query) || jobTitle.includes(query) || company.includes(query);
                              });
                              return filteredRegs.length > 0 && filteredRegs.every((r: any) => selectedRegistrationIds.has(r.id));
                            })()}
                            onChange={(e) => {
                              const filteredRegs = eventRegistrations.filter((reg: any) => {
                                if (!teamSearchQuery.trim()) return true;
                                const query = teamSearchQuery.toLowerCase();
                                const fullName = (reg.full_name || '').toLowerCase();
                                const email = (reg.email || '').toLowerCase();
                                const jobTitle = (reg.job_title || '').toLowerCase();
                                const company = (reg.company || '').toLowerCase();
                                return fullName.includes(query) || email.includes(query) || jobTitle.includes(query) || company.includes(query);
                              });
                              if (e.target.checked) {
                                const newSet = new Set(selectedRegistrationIds);
                                filteredRegs.forEach((r: any) => newSet.add(r.id));
                                setSelectedRegistrationIds(newSet);
                              } else {
                                const newSet = new Set(selectedRegistrationIds);
                                filteredRegs.forEach((r: any) => newSet.delete(r.id));
                                setSelectedRegistrationIds(newSet);
                              }
                            }}
                            className="rounded"
                          />
                        </Th>
                        <Th>Name</Th>
                        <Th>Email</Th>
                        <Th>Job Title</Th>
                        <Th>Company</Th>
                        <Th>Primary Contact</Th>
                      </Tr>
                    </THead>
                    <TBody>
                      {eventRegistrations
                        .filter((reg: any) => {
                          if (!teamSearchQuery.trim()) return true;
                          const query = teamSearchQuery.toLowerCase();
                          const fullName = (reg.full_name || '').toLowerCase();
                          const email = (reg.email || '').toLowerCase();
                          const jobTitle = (reg.job_title || '').toLowerCase();
                          const company = (reg.company || '').toLowerCase();
                          return fullName.includes(query) || email.includes(query) || jobTitle.includes(query) || company.includes(query);
                        })
                        .sort((a: any, b: any) => {
                          // Priority 1: Already selected members at the top
                          const aSelected = selectedRegistrationIds.has(a.id);
                          const bSelected = selectedRegistrationIds.has(b.id);
                          if (aSelected && !bSelected) return -1;
                          if (!aSelected && bSelected) return 1;

                          // Priority 2: Same company as sponsor (case-insensitive comparison)
                          const sponsorCompany = (managingSponsor?.sponsor?.name || '').toLowerCase().trim();
                          const aCompany = (a.company || '').toLowerCase().trim();
                          const bCompany = (b.company || '').toLowerCase().trim();
                          const aSameCompany = sponsorCompany && aCompany && aCompany.includes(sponsorCompany);
                          const bSameCompany = sponsorCompany && bCompany && bCompany.includes(sponsorCompany);
                          if (aSameCompany && !bSameCompany) return -1;
                          if (!aSameCompany && bSameCompany) return 1;

                          // Priority 3: Alphabetical by name
                          const aName = (a.full_name || '').toLowerCase();
                          const bName = (b.full_name || '').toLowerCase();
                          return aName.localeCompare(bName);
                        })
                        .map((reg: any) => {
                          const isSelected = selectedRegistrationIds.has(reg.id);
                          const sponsorCompany = (managingSponsor?.sponsor?.name || '').toLowerCase().trim();
                          const regCompany = (reg.company || '').toLowerCase().trim();
                          const isSameCompany = sponsorCompany && regCompany && regCompany.includes(sponsorCompany);

                          return (
                            <Tr
                              key={reg.id}
                              className={
                                isSelected ? 'bg-blue-50 dark:bg-blue-900/20' :
                                isSameCompany ? 'bg-green-50 dark:bg-green-900/10' : ''
                              }
                            >
                              <Td>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={(e) => {
                                    const newSet = new Set(selectedRegistrationIds);
                                    if (e.target.checked) {
                                      newSet.add(reg.id);
                                    } else {
                                      newSet.delete(reg.id);
                                    }
                                    setSelectedRegistrationIds(newSet);
                                  }}
                                  className="rounded"
                                />
                              </Td>
                              <Td>
                                <div className="flex items-center gap-2">
                                  {reg.full_name || 'N/A'}
                                  {isSelected && (
                                    <Badge variant="soft" color="blue">
                                      Selected
                                    </Badge>
                                  )}
                                  {!isSelected && isSameCompany && (
                                    <Badge variant="soft" color="green">
                                      Same Company
                                    </Badge>
                                  )}
                                </div>
                              </Td>
                              <Td>
                                <span className="text-[var(--gray-a11)]">{reg.email || 'N/A'}</span>
                              </Td>
                              <Td>
                                <span className="text-[var(--gray-a11)]">{reg.job_title || '-'}</span>
                              </Td>
                              <Td>
                                <span className="text-[var(--gray-a11)]">{reg.company || '-'}</span>
                              </Td>
                              <Td>
                                <input
                                  type="radio"
                                  name="primaryContact"
                                  checked={primaryContactId === reg.id}
                                  onChange={() => setPrimaryContactId(reg.id)}
                                  disabled={!isSelected}
                                  className="rounded-full disabled:opacity-30 disabled:cursor-not-allowed"
                                  title={isSelected ? 'Set as primary contact' : 'Select as team member first'}
                                />
                              </Td>
                            </Tr>
                          );
                        })}
                    </TBody>
                  </Table>
                </div>

                <div className="flex items-center justify-between pt-4 border-t border-[var(--gray-a6)]">
                  <p className="text-sm text-[var(--gray-a11)]">
                    {selectedRegistrationIds.size} selected
                  </p>
                  <div className="flex gap-3">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setShowTeamModal(false);
                        setManagingSponsor(null);
                        setSelectedRegistrationIds(new Set());
                      }}
                    >
                      Cancel
                    </Button>
                    <Button variant="primary" onClick={handleSaveTeam} disabled={teamModalLoading}>
                      Save Team
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      {/* View Scans Modal */}
      {showScansModal && viewingSponsor && (
        <Modal
          isOpen={showScansModal}
          onClose={() => {
            setShowScansModal(false);
            setViewingSponsor(null);
            setTeamStats([]);
            setTeamScans([]);
          }}
          title={`Scans - ${viewingSponsor.sponsor?.name}`}
          size="large"
        >
          <div className="space-y-6">
            {scansModalLoading ? (
              <div className="flex justify-center py-8">
                <LoadingSpinner size="medium" />
              </div>
            ) : (
              <>
                {/* Team Statistics */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-semibold text-[var(--gray-12)]">Team Members</h4>
                    <Button variant="secondary" size="sm" onClick={() => handleExportCSV()}>
                      Export All Scans
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 gap-3">
                    {teamStats.map((member: any) => (
                      <div
                        key={member.people_profile_id}
                        className="flex items-center justify-between p-3 bg-[var(--gray-a3)] rounded-lg"
                      >
                        <div>
                          <p className="font-medium text-[var(--gray-12)]">{member.full_name}</p>
                          <p className="text-sm text-[var(--gray-a11)]">{member.email}</p>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="text-right">
                            <p className="text-2xl font-bold text-[var(--blue-11)]">
                              {member.scan_count}
                            </p>
                            <p className="text-xs text-[var(--gray-a11)]">scans</p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleExportCSV(member.people_profile_id)}
                            disabled={member.scan_count === 0}
                          >
                            Export
                          </Button>
                        </div>
                      </div>
                    ))}
                    {teamStats.length === 0 && (
                      <p className="text-center text-[var(--gray-a11)] py-4">No team members assigned yet</p>
                    )}
                  </div>
                </div>

                {/* Recent Scans */}
                <div>
                  <h4 className="font-semibold text-[var(--gray-12)] mb-3">
                    Recent Scans ({teamScans.length})
                  </h4>
                  <div className="max-h-96 overflow-y-auto border border-[var(--gray-a6)] rounded-lg">
                    <Table>
                      <THead>
                        <Tr>
                          <Th>Scanned Person</Th>
                          <Th>Company</Th>
                          <Th>Scanner</Th>
                          <Th>Interest</Th>
                          <Th>Date</Th>
                        </Tr>
                      </THead>
                      <TBody>
                        {teamScans.map((scan: any) => {
                          const scannedCustomer = scan.scanned?.customer;
                          const scannerCustomer = scan.scanner?.customer;
                          return (
                            <Tr key={scan.id}>
                              <Td>
                                <div className="text-sm font-medium">
                                  {scannedCustomer?.attributes?.first_name} {scannedCustomer?.attributes?.last_name}
                                </div>
                                <div className="text-xs text-[var(--gray-a11)]">{scannedCustomer?.email}</div>
                              </Td>
                              <Td>
                                <span className="text-[var(--gray-a11)]">{scannedCustomer?.attributes?.company || '-'}</span>
                              </Td>
                              <Td>
                                <span className="text-[var(--gray-a11)]">{scannerCustomer?.attributes?.first_name} {scannerCustomer?.attributes?.last_name}</span>
                              </Td>
                              <Td>
                                {scan.interest_level && (
                                  <Badge
                                    variant="soft"
                                    color={
                                      scan.interest_level === 'hot'
                                        ? 'red'
                                        : scan.interest_level === 'warm'
                                        ? 'yellow'
                                        : 'blue'
                                    }
                                  >
                                    {scan.interest_level}
                                  </Badge>
                                )}
                              </Td>
                              <Td>
                                <span className="text-xs text-[var(--gray-a11)]">
                                  {scan.scanned_at ? new Date(scan.scanned_at).toLocaleString() : '-'}
                                </span>
                              </Td>
                            </Tr>
                          );
                        })}
                      </TBody>
                    </Table>
                    {teamScans.length === 0 && (
                      <p className="text-center text-[var(--gray-a11)] py-8">No scans yet</p>
                    )}
                  </div>
                </div>

                <div className="flex justify-end pt-4 border-t border-[var(--gray-a6)]">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setShowScansModal(false);
                      setViewingSponsor(null);
                      setTeamStats([]);
                      setTeamScans([]);
                    }}
                  >
                    Close
                  </Button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      {/* Email Sponsor Team Modal */}
      {showEmailModal && emailingSponsor && event && (
        <SendSponsorEmailModal
          isOpen={showEmailModal}
          onClose={() => {
            setShowEmailModal(false);
            setEmailingSponsor(null);
            setEmailTeamMembers([]);
          }}
          eventName={event.eventTitle || ''}
          eventSponsorId={emailingSponsor.id}
          sponsorName={emailingSponsor.sponsor?.name || ''}
          teamMembers={emailTeamMembers}
          onGenerateScansCSV={() => generateScansCSV(emailingSponsor.id)}
          onGenerateRegistrationsCSV={generateRegistrationsCSV}
          eventData={{
            event_id: event.eventId,
            event_title: event.eventTitle,
            event_city: event.eventCity,
            event_country_code: event.eventCountryCode,
            event_start: event.eventStart,
            event_end: event.eventEnd,
          }}
          sponsorData={{
            name: emailingSponsor.sponsor?.name || '',
            slug: emailingSponsor.sponsor?.slug,
          }}
        />
      )}
    </>
  );
}

export default EventSponsorsTab;
