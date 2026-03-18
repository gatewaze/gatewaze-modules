import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowPathIcon,
  UserGroupIcon,
  GiftIcon,
  EyeIcon,
} from '@heroicons/react/24/outline';
import { Card, Button, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { ScrollableTable } from '@/components/shared/table/ScrollableTable';
import { RowActions } from '@/components/shared/table/RowActions';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { ActiveOfferService as OfferService, type OfferSummary } from '@/utils/serviceSwitcher';
import { useAccountAccess } from '@/hooks/useAccountAccess';

export default function OffersPage() {
  const navigate = useNavigate();
  const [offers, setOffers] = useState<OfferSummary[]>([]);
  const [filteredOffers, setFilteredOffers] = useState<OfferSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<string>('all');
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([]);

  // Get account access info for filtering
  const { isSystemAdmin, accounts: userAccounts, loading: accessLoading } = useAccountAccess();

  useEffect(() => {
    // Wait for access check to complete before loading offers
    if (accessLoading) return;

    loadOffers();

    // Auto-refresh every 5 minutes
    const interval = setInterval(() => {
      console.log('🔄 Auto-refreshing offers data...');
      loadOffers();
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [accessLoading, isSystemAdmin, userAccounts]);

  useEffect(() => {
    // Filter offers when selectedAccount changes
    if (selectedAccount === 'all') {
      setFilteredOffers(offers);
    } else if (selectedAccount === 'unassigned') {
      setFilteredOffers(offers.filter(offer => !offer.account_id));
    } else {
      setFilteredOffers(offers.filter(offer => offer.account_id === selectedAccount));
    }
  }, [selectedAccount, offers]);

  const loadOffers = async () => {
    setLoading(true);
    try {
      // For non-system admins, filter offers by their account IDs
      const accountIdsFilter = isSystemAdmin ? undefined : userAccounts.map(a => a.id);
      const result = await OfferService.getAllOffers(accountIdsFilter);
      setOffers(result);
      setLastUpdated(new Date());

      // Extract unique accounts from offers
      const accountsMap = new Map<string, string>();
      result.forEach(offer => {
        if (offer.account_id && offer.account_name) {
          accountsMap.set(offer.account_id, offer.account_name);
        }
      });
      const uniqueAccounts = Array.from(accountsMap.entries()).map(([id, name]) => ({ id, name }));
      uniqueAccounts.sort((a, b) => a.name.localeCompare(b.name));
      setAccounts(uniqueAccounts);
    } catch (error) {
      console.error('Failed to load offers:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleViewDetails = (offer: OfferSummary) => {
    navigate(`/offers/${encodeURIComponent(offer.offer_id)}/detail`);
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatRelativeTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) {
      return `${diffMins}m ago`;
    } else if (diffHours < 24) {
      return `${diffHours}h ago`;
    } else if (diffDays < 30) {
      return `${diffDays}d ago`;
    } else {
      return formatDate(dateStr);
    }
  };

  const renderOfferRow = (offer: OfferSummary, index: number) => {
    return (
      <Tr key={`${offer.offer_id}-${index}`}>
        {/* Offer ID */}
        <Td data-sticky-left style={{ position: 'sticky', left: 0, zIndex: 10, background: 'var(--color-panel-solid)' }}>
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium font-mono">
                {offer.offer_id}
              </div>
            </div>
          </div>
        </Td>

        {/* Account */}
        <Td>
          {offer.account_name ? (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
              {offer.account_name}
            </span>
          ) : (
            <span className="text-[var(--gray-a11)] italic">Unassigned</span>
          )}
        </Td>

        {/* First Interaction */}
        <Td>
          {formatDate(offer.first_interaction)}
        </Td>

        {/* Last Interaction */}
        <Td>
          {formatRelativeTime(offer.last_interaction)}
        </Td>

        {/* Accepted Count */}
        <Td>
          <div className="flex items-center gap-2">
            <UserGroupIcon className="size-4 text-gray-400" />
            <span className="text-sm font-semibold">
              {offer.accepted_count.toLocaleString()}
            </span>
          </div>
        </Td>

        {/* Actions */}
        <Td data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 1 }}>
          <RowActions actions={[
            { label: "View details", icon: <EyeIcon className="size-4" />, onClick: () => handleViewDetails(offer) },
          ]} />
        </Td>
      </Tr>
    );
  };

  if ((loading || accessLoading) && offers.length === 0) {
    return (
      <Page title="Offers">
        <div className="p-6 flex items-center justify-center h-64">
          <LoadingSpinner size="medium" />
        </div>
      </Page>
    );
  }

  const totalAccepted = filteredOffers.reduce((sum, offer) => sum + offer.accepted_count, 0);

  return (
    <Page title="Offers">
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Offers Dashboard
            </h1>
          </div>
          <div className="flex gap-3 items-center">
            {lastUpdated && (
              <span className="text-sm text-gray-500">
                Last updated: {lastUpdated.toLocaleTimeString()}
              </span>
            )}
            <Button
              onClick={() => loadOffers()}
              variant="outline"
              disabled={loading}
            >
              <ArrowPathIcon className={`size-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Filter Section - only show for system admins */}
        {isSystemAdmin ? (
          <Card variant="surface" className="p-4">
            <div className="flex items-center gap-4">
              <label htmlFor="account-filter" className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Filter by Account:
              </label>
              <select
                id="account-filter"
                value={selectedAccount}
                onChange={(e) => setSelectedAccount(e.target.value)}
                className="block w-64 rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 dark:bg-gray-800 dark:border-gray-600 dark:text-white text-sm"
              >
                <option value="all">All Accounts ({offers.length})</option>
                <option value="unassigned">Unassigned ({offers.filter(o => !o.account_id).length})</option>
                {accounts.map(account => (
                  <option key={account.id} value={account.id}>
                    {account.name} ({offers.filter(o => o.account_id === account.id).length})
                  </option>
                ))}
              </select>
              {selectedAccount !== 'all' && (
                <Button
                  variant="ghost"
                  onClick={() => setSelectedAccount('all')}
                >
                  Clear filter
                </Button>
              )}
            </div>
          </Card>
        ) : userAccounts.length > 0 && (
          <Card variant="surface" className="p-4">
            <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
              <span>Showing offers for:</span>
              {userAccounts.map((account, idx) => (
                <span key={account.id}>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                    {account.name}
                  </span>
                  {idx < userAccounts.length - 1 && <span className="ml-1">,</span>}
                </span>
              ))}
            </div>
          </Card>
        )}

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card variant="surface" className="p-6">
            <div className="text-sm font-medium text-neutral-500">
              {selectedAccount === 'all' ? 'Total Offers' : 'Filtered Offers'}
            </div>
            <div className="text-3xl font-bold mt-2">{filteredOffers.length}</div>
            {selectedAccount !== 'all' && (
              <div className="text-xs text-gray-500 mt-1">of {offers.length} total</div>
            )}
          </Card>
          <Card variant="surface" className="p-6">
            <div className="text-sm font-medium text-neutral-500">Total Accepted</div>
            <div className="text-3xl font-bold mt-2">{totalAccepted.toLocaleString()}</div>
          </Card>
        </div>

        {/* Offers Table */}
        <Card variant="surface" className="overflow-hidden">
          <ScrollableTable>
            <Table>
              <THead>
                <Tr>
                  <Th data-sticky-left style={{ position: 'sticky', left: 0, zIndex: 20, background: 'var(--color-panel-solid)' }}>Offer ID</Th>
                  <Th>Account</Th>
                  <Th>First Seen</Th>
                  <Th>Last Activity</Th>
                  <Th>Accepted</Th>
                  <Th data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 2 }} />
                </Tr>
              </THead>
              <TBody>
                {filteredOffers.map((offer, idx) => renderOfferRow(offer, idx))}
              </TBody>
            </Table>
          </ScrollableTable>

          {filteredOffers.length === 0 && offers.length > 0 && (
            <div className="text-center py-12">
              <GiftIcon className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
                No offers found
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                No offers match the selected filter.
              </p>
            </div>
          )}

          {offers.length === 0 && (
            <div className="text-center py-12">
              <GiftIcon className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
                No offers found
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                No offers have been recorded in the offer_interactions table yet.
              </p>
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
