import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  CalendarIcon,
  TrophyIcon,
  ArrowPathIcon,
  ClockIcon,
  UserGroupIcon,
  CheckCircleIcon,
  XCircleIcon,
  MinusCircleIcon,
  TrashIcon,
  PencilIcon,
  MagnifyingGlassIcon,
  EyeIcon,
} from '@heroicons/react/24/outline';
import { Card, Badge, Button, Tabs, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { WinnerService } from '@/utils/winnerService';
import { PersonProfile, winnerSelectionService } from '@/utils/winnerSelectionService';
import { CompetitionWinnerService, CompetitionWinner } from '@/utils/competitionWinnerService';
import { CompetitionDiscountService, EventCompetition } from '@/utils/competitionDiscountService';
import { EditWinnerModal } from '@/components/competitions/EditWinnerModal';
import WinnerSelectionModal from '@/components/WinnerSelectionModal';
import { PeopleService } from '@/utils/peopleService';
import { supabase } from '@/lib/supabase';
import { useAccountAccess } from '@/hooks/useAccountAccess';

type TabType = 'current' | 'past' | 'winners';

// Extended competition type with joined event metadata
interface CompetitionWithEvent extends EventCompetition {
  event?: {
    event_title: string;
    event_city?: string;
    event_country_code?: string;
    event_logo?: string;
    event_start?: string;
    event_end?: string;
    event_id: string;
    account_id?: string;
  } | null;
}

export default function CompetitionsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [competitions, setCompetitions] = useState<CompetitionWithEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const { isAccountUser, accounts, isSystemAdmin, loading: accountsLoading } = useAccountAccess();

  // Get tab from URL query param, default to 'current'
  const tabFromUrl = searchParams.get('tab') as TabType || 'current';
  const [activeTab, setActiveTab] = useState<TabType>(tabFromUrl);

  // Sync URL with tab changes
  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab);
    setSearchParams({ tab });
  };

  // Update active tab when URL changes (e.g., browser back/forward)
  useEffect(() => {
    const urlTab = searchParams.get('tab') as TabType || 'current';
    if (urlTab !== activeTab) {
      setActiveTab(urlTab);
    }
  }, [searchParams, activeTab]);
  const [winnerCounts, setWinnerCounts] = useState<Map<string, number>>(new Map());
  const [isLoadingWinners, setIsLoadingWinners] = useState(false);
  const [allWinners, setAllWinners] = useState<CompetitionWinner[]>([]);
  const [isLoadingAllWinners, setIsLoadingAllWinners] = useState(false);
  const [winnersCustomerData, setWinnersCustomerData] = useState<Map<string, { id: number; first_name?: string; last_name?: string }>>(new Map());
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [winnerToDelete, setWinnerToDelete] = useState<CompetitionWinner | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [totalValueSavedUSD, setTotalValueSavedUSD] = useState<number>(0);
  const [isLoadingTotalValue, setIsLoadingTotalValue] = useState(false);

  // Competition entries modal state
  const [selectedCompetition, setSelectedCompetition] = useState<CompetitionWithEvent | null>(null);
  const [isEntriesModalOpen, setIsEntriesModalOpen] = useState(false);
  const [entriesCustomers, setEntriesCustomers] = useState<PersonProfile[]>([]);
  const [isLoadingEntries, setIsLoadingEntries] = useState(false);
  const [currentCyclingEmail, setCurrentCyclingEmail] = useState<string>('');
  const [isWinnerModalOpen, setIsWinnerModalOpen] = useState(false);
  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set());
  const [entriesSearchTerm, setEntriesSearchTerm] = useState<string>('');
  const [isMarkingWinners, setIsMarkingWinners] = useState(false);

  // Winners modal state
  const [isWinnersListModalOpen, setIsWinnersListModalOpen] = useState(false);
  const [selectedEventWinners, setSelectedEventWinners] = useState<CompetitionWinner[]>([]);
  const [isLoadingEventWinners, setIsLoadingEventWinners] = useState(false);
  const [editingWinner, setEditingWinner] = useState<CompetitionWinner | null>(null);
  const [isEditWinnerModalOpen, setIsEditWinnerModalOpen] = useState(false);

  // Bulk selection state
  const [selectedWinnerIds, setSelectedWinnerIds] = useState<Set<number>>(new Set());
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);

  // State for entries counts (from competition_entries table)
  const [entriesCounts, setEntriesCounts] = useState<Map<string, number>>(new Map());
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Separate current and past competitions
  const { currentCompetitions, pastCompetitions } = useMemo(() => {
    const now = new Date();

    const current = competitions.filter(comp => {
      if (comp.status === 'cancelled') return false;
      if (!comp.closeDate) return comp.status === 'active';
      const closeDate = new Date(comp.closeDate);
      return closeDate > now;
    }).sort((a, b) => {
      // Sort by close date ascending (soonest first)
      if (!a.closeDate) return 1;
      if (!b.closeDate) return -1;
      return new Date(a.closeDate).getTime() - new Date(b.closeDate).getTime();
    });

    const past = competitions.filter(comp => {
      if (comp.status === 'cancelled') return true;
      if (!comp.closeDate) return comp.status === 'closed';
      const closeDate = new Date(comp.closeDate);
      return closeDate <= now;
    }).sort((a, b) => {
      // Sort by close date descending (most recent first)
      if (!a.closeDate) return 1;
      if (!b.closeDate) return -1;
      return new Date(b.closeDate).getTime() - new Date(a.closeDate).getTime();
    });

    return { currentCompetitions: current, pastCompetitions: past };
  }, [competitions]);

  useEffect(() => {
    // Wait for accounts to load before fetching competitions
    if (accountsLoading) {
      return;
    }

    loadCompetitions();
    // For system admins, load winners immediately. For account users, wait for competitions to load first
    if (!isAccountUser || isSystemAdmin) {
      loadAllWinners();
      loadTotalValueSaved();
    }

    // Auto-refresh every 5 minutes
    const interval = setInterval(() => {
      console.log('Auto-refreshing competitions data...');
      loadCompetitions();
      // For system admins, load winners immediately. For account users, it will reload via competitions useEffect
      if (!isAccountUser || isSystemAdmin) {
        loadAllWinners();
        loadTotalValueSaved();
      }
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [accountsLoading, isAccountUser, isSystemAdmin, accounts.length]);

  // Load winner counts and entries counts when competitions change
  useEffect(() => {
    if (competitions.length > 0) {
      loadWinnerCounts();
      loadEntriesCounts();
      // Reload winners to apply account filtering after competitions are loaded
      if (isAccountUser && !isSystemAdmin) {
        loadAllWinners();
      }
    }
  }, [competitions, isAccountUser, isSystemAdmin]);

  const loadCompetitions = async () => {
    setLoading(true);
    try {
      // Query event_competitions with a left join to events for metadata
      const { data, error } = await supabase
        .from('events_competitions')
        .select('*, events(event_title, event_city, event_country_code, event_logo, event_start, event_end, event_id, account_id)')
        .order('sort_order', { ascending: true });

      if (error) {
        console.error('Failed to load competitions:', error);
        setCompetitions([]);
        return;
      }

      let mapped: CompetitionWithEvent[] = (data || []).map((row: any) => ({
        id: row.id,
        eventId: row.event_id || '',
        title: row.title,
        slug: row.slug,
        value: row.value,
        closeDate: row.close_date,
        closeDisplay: row.close_display,
        result: row.result,
        intro: row.intro,
        isBeta: row.is_beta ?? false,
        status: row.status,
        sortOrder: row.sort_order ?? 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        event: row.events ? {
          event_title: row.events.event_title,
          event_city: row.events.event_city,
          event_country_code: row.events.event_country_code,
          event_logo: row.events.event_logo,
          event_start: row.events.event_start,
          event_end: row.events.event_end,
          event_id: row.events.event_id,
          account_id: row.events.account_id,
        } : null,
      }));

      // Filter competitions for account users
      if (isAccountUser && !isSystemAdmin) {
        const accountIds = accounts.map(acc => acc.id);
        console.log('Account User Filtering:', {
          isAccountUser,
          isSystemAdmin,
          userAccounts: accounts,
          accountIds,
          totalCompetitions: mapped.length,
        });

        mapped = mapped.filter(comp => {
          // Standalone competitions (no event) are not visible to account users
          if (!comp.event) return false;
          const hasAccountId = comp.event.account_id && accountIds.includes(comp.event.account_id);
          if (!hasAccountId && comp.event.account_id) {
            console.log('Filtered out competition:', comp.title, 'accountId:', comp.event.account_id);
          }
          return hasAccountId;
        });

        console.log('Filtered to', mapped.length, 'competitions for account user');
      } else {
        console.log('System Admin - showing all', mapped.length, 'competitions');
      }

      setCompetitions(mapped);
    } catch (error) {
      console.error('Failed to load competitions:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadWinnerCounts = async () => {
    setIsLoadingWinners(true);
    try {
      // Get event_ids from competitions that have linked events
      const eventIds = competitions
        .filter(comp => comp.eventId)
        .map(comp => comp.eventId);
      const counts = await WinnerService.getWinnerCountsForEvents(eventIds);
      setWinnerCounts(counts);
    } catch (error) {
      console.error('Error loading winner counts:', error);
    } finally {
      setIsLoadingWinners(false);
    }
  };

  const loadEntriesCounts = async () => {
    setIsLoadingEntries(true);
    try {
      const counts = new Map<string, number>();

      // Get entries count from competition_entries table using competition UUID
      await Promise.all(
        competitions.map(async (comp) => {
          try {
            const result = await CompetitionDiscountService.getCompetitionEntryCount(comp.id);
            if (result.success && result.data !== undefined) {
              counts.set(comp.id, result.data);
              console.log(`Competition ${comp.slug}: ${result.data} entries (from competition_entries)`);
            } else {
              counts.set(comp.id, 0);
            }
          } catch (error) {
            console.error(`Error loading entries count for ${comp.slug}:`, error);
            counts.set(comp.id, 0);
          }
        })
      );

      setEntriesCounts(counts);
      setLastUpdated(new Date());
    } catch (error) {
      console.error('Error loading entries counts:', error);
    } finally {
      setIsLoadingEntries(false);
    }
  };

  const loadAllWinners = async () => {
    setIsLoadingAllWinners(true);
    try {
      let winners = await CompetitionWinnerService.getAllWinners();

      // Filter winners for account users - only show winners from their account's competitions
      if (isAccountUser && !isSystemAdmin) {
        const accountEventIds = competitions
          .filter(comp => comp.eventId)
          .map(comp => comp.eventId);
        console.log('Filtering winners for account user:', {
          totalWinners: winners.length,
          accountCompetitions: accountEventIds.length,
          accountEventIds,
          sampleWinnerEventIds: winners.slice(0, 5).map(w => ({ email: w.email, event_id: w.event_id }))
        });
        winners = winners.filter(winner => {
          return accountEventIds.includes(winner.event_id);
        });
        console.log('Filtered to', winners.length, 'winners for account user');
      }

      setAllWinners(winners);

      // Fetch customer data for all winners
      const customerDataMap = new Map<string, { id: number; first_name?: string; last_name?: string }>();
      const uniqueEmails = [...new Set(winners.map(w => w.email))];

      await Promise.all(
        uniqueEmails.map(async (email) => {
          try {
            const customer = await PeopleService.getPersonByEmail(email);
            if (customer?.id) {
              customerDataMap.set(email, {
                id: customer.id,
                first_name: customer.attributes?.first_name,
                last_name: customer.attributes?.last_name
              });
            }
          } catch (error) {
            console.error(`Error fetching customer for ${email}:`, error);
          }
        })
      );

      setWinnersCustomerData(customerDataMap);
    } catch (error) {
      console.error('Error loading all winners:', error);
    } finally {
      setIsLoadingAllWinners(false);
    }
  };

  const loadTotalValueSaved = async () => {
    setIsLoadingTotalValue(true);
    try {
      const { data, error } = await supabase.rpc('events_get_total_competition_value');

      if (error) {
        console.error('Error loading total value saved:', error);
      } else {
        setTotalValueSavedUSD(data || 0);
      }
    } catch (error) {
      console.error('Error loading total value saved:', error);
    } finally {
      setIsLoadingTotalValue(false);
    }
  };

  const handleDeleteClick = (winner: CompetitionWinner) => {
    setWinnerToDelete(winner);
    setDeleteModalOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!winnerToDelete?.id) return;

    setIsDeleting(true);
    try {
      const result = await CompetitionWinnerService.deleteWinner(winnerToDelete.id);
      if (result.success) {
        // Refresh the winners list
        await loadAllWinners();
        // Also refresh winner counts for the competitions table
        await loadWinnerCounts();
        setDeleteModalOpen(false);
        setWinnerToDelete(null);
      } else {
        console.error('Failed to delete winner:', result.error);
        alert(`Failed to delete winner: ${result.error}`);
      }
    } catch (error) {
      console.error('Error deleting winner:', error);
      alert('An unexpected error occurred while deleting the winner');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteModalOpen(false);
    setWinnerToDelete(null);
  };

  const handleEditEvent = (eventId: string) => {
    window.location.href = `/events?edit=${eventId}`;
  };

  const handleEntriesClick = (competition: CompetitionWithEvent) => {
    navigate(`/competitions/${competition.id}/entries`);
  };

  const handleViewDetails = (competition: CompetitionWithEvent) => {
    navigate(`/competitions/${competition.id}/detail`);
  };

  const handleWinnerModalOpen = (selectedEmail?: string) => {
    if (selectedEmail) {
      setCurrentCyclingEmail(selectedEmail);
    }
    setIsWinnerModalOpen(true);
  };

  const handleWinnerModalClose = () => {
    setIsWinnerModalOpen(false);
    setCurrentCyclingEmail('');
  };

  const handleWinnersClick = async (competition: CompetitionWithEvent) => {
    setSelectedCompetition(competition);
    setIsWinnersListModalOpen(true);
    setIsLoadingEventWinners(true);
    setSelectedEventWinners([]);

    try {
      // Use the competition's linked event_id to look up winners
      if (competition.eventId) {
        const winners = await CompetitionWinnerService.getWinnersForEvent(competition.eventId);
        setSelectedEventWinners(winners);
      } else {
        setSelectedEventWinners([]);
      }
    } catch (error) {
      console.error('Error loading winners:', error);
      setSelectedEventWinners([]);
    } finally {
      setIsLoadingEventWinners(false);
    }
  };

  const handleEditWinner = (winner: CompetitionWinner) => {
    setEditingWinner(winner);
    setIsEditWinnerModalOpen(true);
  };

  const handleEditWinnerSuccess = async () => {
    // Reload all winners data
    await loadAllWinners();

    // Reload total value saved (only for system admins)
    if (!isAccountUser || isSystemAdmin) {
      await loadTotalValueSaved();
    }

    // Reload winners list if modal is open
    if (selectedCompetition && selectedCompetition.eventId) {
      const winners = await CompetitionWinnerService.getWinnersForEvent(selectedCompetition.eventId);
      setSelectedEventWinners(winners);
    }
  };

  const handleToggleWinnerSelection = (winnerId: number) => {
    setSelectedWinnerIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(winnerId)) {
        newSet.delete(winnerId);
      } else {
        newSet.add(winnerId);
      }
      return newSet;
    });
  };

  const handleToggleAllWinners = () => {
    if (selectedWinnerIds.size === allWinners.length) {
      setSelectedWinnerIds(new Set());
    } else {
      setSelectedWinnerIds(new Set(allWinners.map(w => w.id).filter((id): id is number => id !== undefined)));
    }
  };

  const handleBulkStatusUpdate = async (status: 'accepted' | 'declined' | 'not_replied') => {
    if (selectedWinnerIds.size === 0) return;

    setIsBulkUpdating(true);
    try {
      const winnersToUpdate = allWinners.filter(w => w.id && selectedWinnerIds.has(w.id));

      for (const winner of winnersToUpdate) {
        if (status === 'accepted') {
          await CompetitionWinnerService.markWinnerAccepted(winner.email, winner.event_id);
        } else if (status === 'declined') {
          await CompetitionWinnerService.markWinnerDeclined(winner.email, winner.event_id);
        } else if (status === 'not_replied') {
          await CompetitionWinnerService.markWinnerNotReplied(winner.email, winner.event_id);
        }
      }

      // Reload winners data
      await loadAllWinners();

      // Reload total value saved if any winners were marked as accepted (only for system admins)
      if (status === 'accepted' && (!isAccountUser || isSystemAdmin)) {
        await loadTotalValueSaved();
      }

      setSelectedWinnerIds(new Set());
    } catch (error) {
      console.error('Error updating winners:', error);
    } finally {
      setIsBulkUpdating(false);
    }
  };

  const handleWinnerClick = async (email: string) => {
    try {
      // Get customer by email
      const customer = await PeopleService.getPersonByEmail(email);
      if (customer?.id) {
        navigate(`/people/${customer.id}`);
      }
    } catch (error) {
      console.error('Error navigating to customer:', error);
    }
  };

  const handleToggleEntry = (email: string) => {
    setSelectedEntries(prev => {
      const newSet = new Set(prev);
      if (newSet.has(email)) {
        newSet.delete(email);
      } else {
        newSet.add(email);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    if (selectedEntries.size === entriesCustomers.length) {
      // Deselect all
      setSelectedEntries(new Set());
    } else {
      // Select all
      setSelectedEntries(new Set(entriesCustomers.map(c => c.email)));
    }
  };

  const handleMarkAsWinners = async () => {
    if (!selectedCompetition || selectedEntries.size === 0) return;
    if (!selectedCompetition.eventId) {
      alert('Cannot mark winners for standalone competitions (no linked event).');
      return;
    }

    setIsMarkingWinners(true);
    try {
      const results = await Promise.allSettled(
        Array.from(selectedEntries).map(email =>
          CompetitionWinnerService.logWinner(email, selectedCompetition.eventId)
        )
      );

      const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
      const failCount = results.length - successCount;

      if (successCount > 0) {
        console.log(`Successfully marked ${successCount} winner(s)`);
        // Refresh winner counts and all winners
        await loadWinnerCounts();
        await loadAllWinners();
        // Clear selection
        setSelectedEntries(new Set());
      }

      if (failCount > 0) {
        console.error(`Failed to mark ${failCount} winner(s)`);
      }

      alert(`Successfully marked ${successCount} winner(s)${failCount > 0 ? `. Failed: ${failCount}` : ''}`);
    } catch (error) {
      console.error('Error marking winners:', error);
      alert('An error occurred while marking winners');
    } finally {
      setIsMarkingWinners(false);
    }
  };

  const getDaysAgo = (dateStr: string) => {
    if (!dateStr) return '';
    const closeDate = new Date(dateStr);
    const now = new Date();
    const diffTime = now.getTime() - closeDate.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    return `${diffDays} days ago`;
  };

  const formatDate = (dateStr?: string | null) => {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const formatEventDate = (startDate?: string, endDate?: string) => {
    if (!startDate) return 'TBA';

    const start = new Date(startDate);
    const startFormatted = start.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });

    // If there's no end date or it's the same as start date, just return start date
    if (!endDate || endDate === startDate) {
      return startFormatted;
    }

    const end = new Date(endDate);
    const startMonth = start.getMonth();
    const endMonth = end.getMonth();
    const startDay = start.getDate();
    const endDay = end.getDate();

    // Same month: "Oct 8-9"
    if (startMonth === endMonth) {
      return `${start.toLocaleDateString('en-US', { month: 'short' })} ${startDay}-${endDay}`;
    }

    // Different months: "Oct 31 - Nov 1"
    return `${startFormatted} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  };

  const getTimeRemaining = (closeDate: string) => {
    const now = new Date().getTime();
    const target = new Date(closeDate).getTime();
    const diff = target - now;

    if (diff <= 0) {
      return { text: 'Closed', color: 'text-gray-500', urgency: 'closed' };
    }

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    if (hours <= 24) {
      return {
        text: `${hours}h remaining`,
        color: 'text-red-600 font-bold',
        urgency: 'critical'
      };
    } else if (hours <= 48) {
      return {
        text: `${hours}h remaining`,
        color: 'text-orange-600 font-semibold',
        urgency: 'urgent'
      };
    } else if (days <= 7) {
      return {
        text: `${days}d ${hours % 24}h`,
        color: 'text-yellow-600',
        urgency: 'soon'
      };
    } else {
      return {
        text: `${days} days`,
        color: 'text-gray-700',
        urgency: 'normal'
      };
    }
  };

  const getUrgencyBadge = (urgency: string) => {
    switch (urgency) {
      case 'critical':
        return <Badge color="error" variant="soft">Critical - 24h</Badge>;
      case 'urgent':
        return <Badge color="warning" variant="soft">Urgent - 48h</Badge>;
      case 'soon':
        return <Badge color="info" variant="soft">Soon</Badge>;
      case 'closed':
        return <Badge color="neutral" variant="soft">Closed</Badge>;
      default:
        return null;
    }
  };

  // Helper to get display title: competition title, falling back to event title
  const getDisplayTitle = (competition: CompetitionWithEvent) => {
    return competition.title || competition.event?.event_title || 'Untitled Competition';
  };

  // Helper to get location string
  const getLocationString = (competition: CompetitionWithEvent) => {
    if (!competition.event) return 'Standalone';
    const parts = [competition.event.event_city, competition.event.event_country_code].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : '';
  };

  const renderCompetitionRow = (competition: CompetitionWithEvent, index: number) => {
    const entriesCount = entriesCounts.get(competition.id) || 0;
    const timeInfo = competition.closeDate ? getTimeRemaining(competition.closeDate) : { text: 'No close date', color: 'text-gray-500', urgency: 'normal' };

    const actions = [
      { label: 'View details', icon: <EyeIcon className="size-4" />, onClick: () => handleViewDetails(competition) },
      ...(competition.eventId ? [{ label: 'Edit event', icon: <PencilIcon className="size-4" />, onClick: () => handleEditEvent(competition.eventId) }] : []),
    ];

    return (
      <Tr key={`current-${competition.id}-${index}`}>
        {/* Competition Info */}
        <Td>
          <div className="flex items-start gap-3">
            {competition.event?.event_logo && (
              <div className="flex-shrink-0 w-20 h-12 bg-black rounded p-1.5">
                <img
                  src={competition.event.event_logo.startsWith('http') ? competition.event.event_logo : `https://www.tech.tickets${competition.event.event_logo}`}
                  alt={getDisplayTitle(competition)}
                  className="w-full h-full object-contain"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium" style={{ color: 'var(--gray-12)' }}>
                {getDisplayTitle(competition)}
              </div>
              <div className="text-sm" style={{ color: 'var(--gray-11)' }}>
                {getLocationString(competition)}
              </div>
              {competition.isBeta && (
                <Badge color="warning" variant="soft" className="mt-1">Beta</Badge>
              )}
            </div>
          </div>
        </Td>

        {/* Event Date */}
        <Td>
          <div className="flex items-center gap-1 text-sm" style={{ color: 'var(--gray-12)' }}>
            <CalendarIcon className="size-4 text-gray-400" />
            {competition.event
              ? formatEventDate(competition.event.event_start, competition.event.event_end)
              : 'N/A'
            }
          </div>
        </Td>

        {/* Close Date */}
        <Td>
          <div className="text-sm" style={{ color: 'var(--gray-12)' }}>
            {formatDate(competition.closeDate)}
          </div>
        </Td>

        {/* Time Remaining */}
        <Td>
          <div className="flex items-center gap-2">
            <ClockIcon className="size-4 text-gray-400" />
            <span className={`text-sm ${timeInfo.color}`}>
              {timeInfo.text}
            </span>
          </div>
          {getUrgencyBadge(timeInfo.urgency)}
        </Td>

        {/* Entry Count */}
        <Td>
          <Button
            variant="ghost"
            onClick={() => handleEntriesClick(competition)}
            disabled={isLoadingEntries || entriesCount === 0}
          >
            <UserGroupIcon className="size-4 text-gray-400" />
            {isLoadingEntries ? (
              <span className="text-sm text-gray-400">...</span>
            ) : (
              <span className="text-sm font-semibold underline decoration-dotted" style={{ color: 'var(--gray-12)' }}>
                {entriesCount.toLocaleString()}
              </span>
            )}
          </Button>
        </Td>

        {/* Actions */}
        <Td>
          <RowActions actions={actions} />
        </Td>
      </Tr>
    );
  };

  const renderPastCompetitionRow = (competition: CompetitionWithEvent, index: number) => {
    const entriesCount = entriesCounts.get(competition.id) || 0;
    const winnerCount = competition.eventId ? (winnerCounts.get(competition.eventId) || 0) : 0;

    const actions = [
      { label: 'View details', icon: <EyeIcon className="size-4" />, onClick: () => handleViewDetails(competition) },
      ...(competition.eventId ? [{ label: 'Edit event', icon: <PencilIcon className="size-4" />, onClick: () => handleEditEvent(competition.eventId) }] : []),
    ];

    return (
      <Tr key={`past-${competition.id}-${index}`}>
        {/* Competition Info */}
        <Td>
          <div className="flex items-start gap-3">
            {competition.event?.event_logo && (
              <div className="flex-shrink-0 w-20 h-12 bg-black rounded p-1.5">
                <img
                  src={competition.event.event_logo.startsWith('http') ? competition.event.event_logo : `https://www.tech.tickets${competition.event.event_logo}`}
                  alt={getDisplayTitle(competition)}
                  className="w-full h-full object-contain"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium" style={{ color: 'var(--gray-12)' }}>
                {getDisplayTitle(competition)}
              </div>
              <div className="text-sm" style={{ color: 'var(--gray-11)' }}>
                {getLocationString(competition)}
              </div>
              {competition.status === 'cancelled' && (
                <Badge color="error" variant="soft" className="mt-1">Cancelled</Badge>
              )}
            </div>
          </div>
        </Td>

        {/* Closed Date */}
        <Td>
          <div className="text-sm" style={{ color: 'var(--gray-12)' }}>
            {formatDate(competition.closeDate)}
          </div>
          {competition.closeDate && (
            <div className="text-xs" style={{ color: 'var(--gray-11)' }}>
              {getDaysAgo(competition.closeDate)}
            </div>
          )}
        </Td>

        {/* Event Date */}
        <Td>
          <div className="flex items-center gap-1 text-sm" style={{ color: 'var(--gray-12)' }}>
            <CalendarIcon className="size-4 text-gray-400" />
            {competition.event
              ? formatEventDate(competition.event.event_start, competition.event.event_end)
              : 'N/A'
            }
          </div>
        </Td>

        {/* Entry Count */}
        <Td>
          <Button
            variant="ghost"
            onClick={() => handleEntriesClick(competition)}
            disabled={isLoadingEntries || entriesCount === 0}
          >
            <UserGroupIcon className="size-4 text-gray-400" />
            {isLoadingEntries ? (
              <span className="text-sm text-gray-400">...</span>
            ) : (
              <span className="text-sm font-semibold underline decoration-dotted" style={{ color: 'var(--gray-12)' }}>
                {entriesCount.toLocaleString()}
              </span>
            )}
          </Button>
        </Td>

        {/* Winner Count */}
        <Td>
          <Button
            variant="ghost"
            onClick={() => handleWinnersClick(competition)}
            disabled={isLoadingWinners || winnerCount === 0}
          >
            <TrophyIcon className="size-4 text-gray-400" />
            {isLoadingWinners ? (
              <span className="text-sm text-gray-400">...</span>
            ) : (
              <span className="text-sm font-semibold underline decoration-dotted" style={{ color: 'var(--gray-12)' }}>
                {winnerCount}
              </span>
            )}
          </Button>
        </Td>

        {/* Actions */}
        <Td>
          <RowActions actions={actions} />
        </Td>
      </Tr>
    );
  };

  const renderWinnerRow = (winner: CompetitionWinner, index: number) => {
    // Find the competition this winner is associated with (by event_id)
    const competition = competitions.find(c => c.eventId === winner.event_id);
    const customerData = winnersCustomerData.get(winner.email);

    const formatStatusDate = (date?: string) => {
      if (!date) return null;
      return new Date(date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    };

    const renderStatusIcon = (timestamp?: string, isDeclined?: boolean) => {
      if (timestamp) {
        return (
          <div className="flex items-center gap-2">
            {isDeclined ? (
              <XCircleIcon className="size-5 text-red-500" />
            ) : (
              <CheckCircleIcon className="size-5 text-green-500" />
            )}
            <span className="text-xs text-[var(--gray-11)]">
              {formatStatusDate(timestamp)}
            </span>
          </div>
        );
      }
      return <MinusCircleIcon className="size-5 text-gray-300 dark:text-gray-600" />;
    };

    return (
      <Tr key={`winner-${winner.id || winner.email}-${index}`}>
        {/* Checkbox */}
        <Td>
          <input
            type="checkbox"
            checked={winner.id ? selectedWinnerIds.has(winner.id) : false}
            onChange={(e) => {
              e.stopPropagation();
              if (winner.id) {
                handleToggleWinnerSelection(winner.id);
              }
            }}
            className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
          />
        </Td>

        {/* Winner Name & Email */}
        <Td
          className="cursor-pointer"
          onClick={() => customerData?.id && navigate(`/people/${customerData.id}`)}
        >
          <div>
            {customerData?.first_name || customerData?.last_name ? (
              <>
                <div className="flex items-center gap-2">
                  <div className="text-sm font-medium" style={{ color: 'var(--gray-12)' }}>
                    {[customerData.first_name, customerData.last_name].filter(Boolean).join(' ')}
                  </div>
                  <div className="flex items-center gap-1">
                    {winner.winner_image_url && (
                      <span className="inline-flex items-center text-blue-600 dark:text-blue-400" title="Has winner image">
                        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </span>
                    )}
                    {winner.social_post_url && (
                      <span className="inline-flex items-center text-purple-600 dark:text-purple-400" title="Has social post">
                        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                        </svg>
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-xs" style={{ color: 'var(--gray-11)' }}>
                  {winner.email}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <div className="text-sm font-medium" style={{ color: 'var(--gray-12)' }}>
                    {winner.email}
                  </div>
                  <div className="flex items-center gap-1">
                    {winner.winner_image_url && (
                      <span className="inline-flex items-center text-blue-600 dark:text-blue-400" title="Has winner image">
                        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </span>
                    )}
                    {winner.social_post_url && (
                      <span className="inline-flex items-center text-purple-600 dark:text-purple-400" title="Has social post">
                        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                        </svg>
                      </span>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </Td>

        {/* Competition */}
        <Td>
          {competition ? (
            <div className="text-sm font-medium" style={{ color: 'var(--gray-12)' }}>
              {getDisplayTitle(competition)}
            </div>
          ) : (
            <div className="text-sm" style={{ color: 'var(--gray-11)' }}>
              Unknown Competition
            </div>
          )}
        </Td>

        {/* Notified */}
        <Td>
          {renderStatusIcon(winner.notified_at)}
        </Td>

        {/* Accepted */}
        <Td>
          {renderStatusIcon(winner.accepted_at)}
        </Td>

        {/* Declined */}
        <Td>
          {renderStatusIcon(winner.declined_at, true)}
        </Td>

        {/* Not Replied */}
        <Td>
          {renderStatusIcon(winner.not_replied_at)}
        </Td>

        {/* Actions */}
        <Td>
          <RowActions actions={[
            { label: 'Edit winner', icon: <PencilIcon className="size-4" />, onClick: () => handleEditWinner(winner) },
            { label: 'Delete winner', icon: <TrashIcon className="size-4" />, onClick: () => handleDeleteClick(winner), color: 'red' },
          ]} />
        </Td>
      </Tr>
    );
  };

  const displayedCompetitions = activeTab === 'current' ? currentCompetitions : pastCompetitions;

  if (loading) {
    return (
      <Page title="Competitions">
        <div className="p-6 flex items-center justify-center h-64">
          <LoadingSpinner size="medium" />
        </div>
      </Page>
    );
  }

  return (
    <Page title="Competitions">
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Competitions Dashboard
            </h1>

          </div>
          <div className="flex gap-3 items-center">
            {lastUpdated && (
              <span className="text-sm text-gray-500">
                Last updated: {lastUpdated.toLocaleTimeString()}
              </span>
            )}
            <Button
              onClick={() => {
                loadCompetitions();
                loadEntriesCounts();
              }}
              variant="outline"
              disabled={loading || isLoadingEntries}
            >
              <ArrowPathIcon className={`size-4 ${(loading || isLoadingEntries) ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Stats Cards */}
        <div className={`grid grid-cols-1 md:grid-cols-2 ${isAccountUser && !isSystemAdmin ? 'lg:grid-cols-3' : 'lg:grid-cols-4'} gap-6`}>
          <Card variant="surface" className="p-6">
            <div className="text-sm font-medium text-neutral-500">Active Competitions</div>
            <div className="text-3xl font-bold mt-2">{currentCompetitions.length}</div>
          </Card>
          <Card variant="surface" className="p-6">
            <div className="text-sm font-medium text-neutral-500">Ended Competitions</div>
            <div className="text-3xl font-bold mt-2">{pastCompetitions.length}</div>
          </Card>
          <Card variant="surface" className="p-6">
            <div className="text-sm font-medium text-neutral-500">Total Entries</div>
            <div className="text-3xl font-bold mt-2">
              {isLoadingEntries ? '...' :
                Array.from(entriesCounts.values())
                  .reduce((sum, count) => sum + count, 0)
                  .toLocaleString()
              }
            </div>
          </Card>
          {/* Hide Total Value Saved for account users */}
          {(!isAccountUser || isSystemAdmin) && (
            <Card variant="surface" className="p-6">
              <div className="text-sm font-medium text-neutral-500">Total Value Saved</div>
              <div className="text-3xl font-bold mt-2">
                {isLoadingTotalValue ? '...' : `$${totalValueSavedUSD.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
              </div>
            </Card>
          )}
        </div>

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onChange={handleTabChange}
          tabs={[
            { id: 'current', label: 'Current', count: currentCompetitions.length },
            { id: 'past', label: 'Past', count: pastCompetitions.length },
            { id: 'winners', label: 'Winners', count: allWinners.length },
          ]}
        />

        {/* Bulk Actions Bar */}
        {activeTab === 'winners' && selectedWinnerIds.size > 0 && (
          <Card variant="surface" className="mb-4">
            <div className="p-4 flex items-center justify-between">
              <div className="text-sm text-[var(--gray-11)]">
                {selectedWinnerIds.size} winner{selectedWinnerIds.size !== 1 ? 's' : ''} selected
              </div>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => handleBulkStatusUpdate('accepted')}
                  disabled={isBulkUpdating}
                  variant="solid"
                  color="green"
                >
                  Mark as Accepted
                </Button>
                <Button
                  onClick={() => handleBulkStatusUpdate('declined')}
                  disabled={isBulkUpdating}
                  variant="solid"
                  color="red"
                >
                  Mark as Declined
                </Button>
                <Button
                  onClick={() => handleBulkStatusUpdate('not_replied')}
                  disabled={isBulkUpdating}
                  variant="solid"
                  color="gray"
                >
                  Mark as Not Replied
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* Competitions Table */}
        <Card variant="surface" className="overflow-hidden">
          <Table>
            <THead>
              <Tr>
                {activeTab === 'winners' ? (
                  <>
                    <Th>
                      <input
                        type="checkbox"
                        checked={selectedWinnerIds.size > 0 && selectedWinnerIds.size === allWinners.length}
                        onChange={handleToggleAllWinners}
                        className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
                      />
                    </Th>
                    <Th>Winner</Th>
                    <Th>Competition</Th>
                    <Th>Notified</Th>
                    <Th>Accepted</Th>
                    <Th>Declined</Th>
                    <Th>Not Replied</Th>
                    <Th />
                  </>
                ) : (
                  <>
                    <Th>Competition</Th>
                    {activeTab === 'current' ? (
                      <>
                        <Th>Event Date</Th>
                        <Th>Closes</Th>
                        <Th>Time Remaining</Th>
                        <Th>Entries</Th>
                        <Th />
                      </>
                    ) : (
                      <>
                        <Th>Closed</Th>
                        <Th>Event Date</Th>
                        <Th>Entries</Th>
                        <Th>Winners</Th>
                        <Th />
                      </>
                    )}
                  </>
                )}
              </Tr>
            </THead>
            <TBody>
              {activeTab === 'winners'
                ? allWinners.map((winner, idx) => renderWinnerRow(winner, idx))
                : activeTab === 'current'
                ? displayedCompetitions.map((comp, idx) => renderCompetitionRow(comp, idx))
                : displayedCompetitions.map((comp, idx) => renderPastCompetitionRow(comp, idx))
              }
            </TBody>
          </Table>

          {activeTab === 'winners' ? (
            allWinners.length === 0 && !isLoadingAllWinners && (
              <div className="text-center py-12">
                <TrophyIcon className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-[var(--gray-12)]">
                  No winners yet
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  Winners will appear here once competitions have been completed and winners selected.
                </p>
              </div>
            )
          ) : (
            displayedCompetitions.length === 0 && (
              <div className="text-center py-12">
                <TrophyIcon className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-[var(--gray-12)]">
                  No {activeTab === 'current' ? 'active' : 'past'} competitions
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {activeTab === 'current'
                    ? 'There are no active competitions at the moment.'
                    : 'No past competitions found.'}
                </p>
              </div>
            )
          )}
        </Card>
      </div>

      {/* Entries List Modal */}
      {isEntriesModalOpen && selectedCompetition && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setIsEntriesModalOpen(false)}>
          <div className="mx-auto max-w-4xl w-full bg-white dark:bg-neutral-800 rounded-lg shadow-xl m-4 max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-neutral-200 dark:border-neutral-700">
              <div>
                <h2 className="text-xl font-semibold text-neutral-900">Competition Entries</h2>
                <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">{getDisplayTitle(selectedCompetition)}</p>
                {selectedCompetition.event && (
                  <p className="text-xs text-neutral-500 dark:text-neutral-500 mt-1">
                    {selectedCompetition.event.event_city}, {selectedCompetition.event.event_country_code} {selectedCompetition.event.event_start ? `\u2022 ${formatDate(selectedCompetition.event.event_start)}` : ''}
                  </p>
                )}
              </div>
              <Button
                isIcon
                variant="ghost"
                onClick={() => setIsEntriesModalOpen(false)}
              >
                <svg className="size-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </Button>
            </div>

            {/* Search and Actions */}
            <div className="p-4 bg-neutral-50 dark:bg-neutral-900 border-b border-neutral-200 dark:border-neutral-700 space-y-4">
              {/* Search bar */}
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-5 text-neutral-400" />
                <input
                  type="text"
                  placeholder="Filter by email address..."
                  value={entriesSearchTerm}
                  onChange={(e) => setEntriesSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-neutral-900"
                />
              </div>

              {/* Stats and actions */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="text-sm text-neutral-600 dark:text-neutral-400">
                    {entriesCustomers.length > 0 ? `${entriesCustomers.filter(c => c.email.toLowerCase().includes(entriesSearchTerm.toLowerCase())).length} entries` : 'Loading entries...'}
                    {selectedEntries.size > 0 && (
                      <span className="ml-2 text-primary-600 dark:text-primary-400 font-medium">
                        ({selectedEntries.size} selected)
                      </span>
                    )}
                  </div>
                  {entriesCustomers.length > 0 && (
                    <Button
                      variant="ghost"
                      onClick={handleSelectAll}
                    >
                      {selectedEntries.size === entriesCustomers.length ? 'Deselect All' : 'Select All'}
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="solid"
                    color="green"
                    onClick={handleMarkAsWinners}
                    disabled={selectedEntries.size === 0 || isMarkingWinners || !selectedCompetition.eventId}
                  >
                    {isMarkingWinners ? (
                      <>
                        <ArrowPathIcon className="size-5 animate-spin" />
                        Marking Winners...
                      </>
                    ) : (
                      <>
                        <TrophyIcon className="size-5" />
                        Mark {selectedEntries.size > 0 ? selectedEntries.size : ''} as Winner{selectedEntries.size !== 1 ? 's' : ''}
                      </>
                    )}
                  </Button>
                  <Button
                    variant="solid"
                    color="orange"
                    onClick={() => handleWinnerModalOpen()}
                    disabled={entriesCustomers.length === 0}
                  >
                    <TrophyIcon className="size-5" />
                    Pick Random Winner
                  </Button>
                </div>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
              {isLoadingEntries ? (
                <div className="text-center py-12">
                  <ArrowPathIcon className="size-12 mx-auto text-neutral-400 animate-spin mb-3" />
                  <p className="text-neutral-600 dark:text-neutral-400">Loading entries...</p>
                </div>
              ) : entriesCustomers.length === 0 ? (
                <div className="text-center py-12">
                  <UserGroupIcon className="size-12 mx-auto text-neutral-400 mb-3" />
                  <p className="text-neutral-600 dark:text-neutral-400">No entries found for this competition</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {entriesCustomers
                    .filter(customer => customer.email.toLowerCase().includes(entriesSearchTerm.toLowerCase()))
                    .map((customer, idx) => {
                      const isSelected = selectedEntries.has(customer.email);
                      return (
                        <div
                          key={`${customer.email}-${idx}`}
                          className={`flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors ${
                            currentCyclingEmail === customer.email ? 'bg-yellow-100 dark:bg-yellow-900/20 border-2 border-yellow-500' : 'border border-transparent'
                          } ${isSelected ? 'bg-primary-50 dark:bg-primary-900/20' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => handleToggleEntry(customer.email)}
                            className="size-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 cursor-pointer"
                          />
                          <Button
                            variant="ghost"
                            onClick={() => handleWinnerModalOpen(customer.email)}
                          >
                            <div className="font-mono text-sm text-neutral-900">{customer.email}</div>
                          </Button>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Winner Selection Modal */}
      {selectedCompetition && (
        <WinnerSelectionModal
          isOpen={isWinnerModalOpen}
          onClose={handleWinnerModalClose}
          customers={entriesCustomers}
          competitionTitle={getDisplayTitle(selectedCompetition)}
          onCyclingEmailChange={setCurrentCyclingEmail}
          eventStart={selectedCompetition.event?.event_start}
          eventEnd={selectedCompetition.event?.event_end}
          preSelectedEmail={currentCyclingEmail}
          eventId={selectedCompetition.eventId || undefined}
        />
      )}

      {/* Winners List Modal */}
      {isWinnersListModalOpen && selectedCompetition && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setIsWinnersListModalOpen(false)}>
          <div className="mx-auto max-w-2xl w-full bg-white dark:bg-neutral-800 rounded-lg shadow-xl m-4 max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-neutral-200 dark:border-neutral-700">
              <div>
                <h2 className="text-xl font-semibold text-neutral-900">Competition Winners</h2>
                <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">{getDisplayTitle(selectedCompetition)}</p>
                {selectedCompetition.event && (
                  <p className="text-xs text-neutral-500 dark:text-neutral-500 mt-1">
                    {selectedCompetition.event.event_city}, {selectedCompetition.event.event_country_code} {selectedCompetition.event.event_start ? `\u2022 ${formatDate(selectedCompetition.event.event_start)}` : ''}
                  </p>
                )}
              </div>
              <Button
                isIcon
                variant="ghost"
                onClick={() => setIsWinnersListModalOpen(false)}
              >
                <svg className="size-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
              {isLoadingEventWinners ? (
                <div className="text-center py-12">
                  <ArrowPathIcon className="size-12 mx-auto text-neutral-400 animate-spin mb-3" />
                  <p className="text-neutral-600 dark:text-neutral-400">Loading winners...</p>
                </div>
              ) : selectedEventWinners.length === 0 ? (
                <div className="text-center py-12">
                  <TrophyIcon className="size-12 mx-auto text-neutral-400 mb-3" />
                  <p className="text-neutral-600 dark:text-neutral-400">No winners found for this competition</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {selectedEventWinners.map((winner, idx) => (
                    <div
                      key={`${winner.email}-${idx}`}
                      className="px-4 py-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <Button
                          variant="ghost"
                          onClick={() => handleWinnerClick(winner.email)}
                        >
                          <div className="font-mono text-sm text-neutral-900">{winner.email}</div>
                          <div className="flex items-center gap-3 mt-1">
                            {winner.notified_at && (
                              <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                                <CheckCircleIcon className="size-3" />
                                Notified
                              </span>
                            )}
                            {winner.accepted_at && (
                              <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                                <CheckCircleIcon className="size-3" />
                                Accepted
                              </span>
                            )}
                            {winner.declined_at && (
                              <span className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
                                <XCircleIcon className="size-3" />
                                Declined
                              </span>
                            )}
                            {winner.not_replied_at && (
                              <span className="text-xs text-yellow-600 dark:text-yellow-400 flex items-center gap-1">
                                <MinusCircleIcon className="size-3" />
                                Not Replied
                              </span>
                            )}
                            {winner.winner_image_url && (
                              <span className="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-1">
                                <svg className="size-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                </svg>
                                Image
                              </span>
                            )}
                            {winner.social_post_url && (
                              <span className="text-xs text-purple-600 dark:text-purple-400 flex items-center gap-1">
                                <svg className="size-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                                </svg>
                                Social
                              </span>
                            )}
                          </div>
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => handleEditWinner(winner)}
                        >
                          Edit
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Edit Winner Modal */}
      {isEditWinnerModalOpen && editingWinner && (
        <EditWinnerModal
          isOpen={isEditWinnerModalOpen}
          onClose={() => setIsEditWinnerModalOpen(false)}
          winner={editingWinner}
          onSuccess={handleEditWinnerSuccess}
        />
      )}

      {/* Delete Winner Confirmation Modal */}
      {deleteModalOpen && winnerToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={handleDeleteCancel}>
          <div className="mx-auto max-w-md w-full bg-white dark:bg-neutral-800 rounded-lg shadow-xl m-4" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="p-6 border-b border-neutral-200 dark:border-neutral-700">
              <h2 className="text-xl font-semibold text-neutral-900">Delete Winner</h2>
            </div>

            {/* Content */}
            <div className="p-6">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                Are you sure you want to delete this winner entry?
              </p>
              <div className="mt-4 p-4 bg-neutral-50 dark:bg-neutral-900 rounded-lg">
                <div className="text-sm font-medium text-neutral-900">
                  {winnerToDelete.email}
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {competitions.find(c => c.eventId === winnerToDelete.event_id)?.title || 'Unknown Competition'}
                </div>
              </div>
              <p className="text-sm text-red-600 dark:text-red-400 mt-4">
                This action cannot be undone.
              </p>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 p-6 border-t border-neutral-200 dark:border-neutral-700">
              <Button
                variant="outline"
                onClick={handleDeleteCancel}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="solid"
                color="red"
                onClick={handleDeleteConfirm}
                disabled={isDeleting}
              >
                {isDeleting ? (
                  <>
                    <ArrowPathIcon className="size-4 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <TrashIcon className="size-4" />
                    Delete
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
